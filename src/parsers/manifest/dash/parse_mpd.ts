/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import config from "../../../config";
import log from "../../../log";
import arrayFind from "../../../utils/array_find";
import idGenerator from "../../../utils/id_generator";
import resolveURL, {
  normalizeBaseURL,
} from "../../../utils/resolve_url";
import { IParsedManifest } from "../types";
import checkManifestIDs from "../utils/check_manifest_ids";
import getPresentationLiveGap from "./get_presentation_live_gap";
import {
  createMPDIntermediateRepresentation,
  IMPDIntermediateRepresentation,
} from "./node_parsers/MPD";
import {
  createPeriodIntermediateRepresentation,
  IPeriodIntermediateRepresentation,
} from "./node_parsers/Period";
import { IScheme } from "./node_parsers/utils";
import parsePeriods from "./parse_periods";

const generateManifestID = idGenerator();

export interface IResource {
  type: "xlink" | "http-iso";
  url: string;
}

export interface IParseOptions {
  manifestURI : string;
  loadExternalClock : boolean;
}

export type IParserResponse<T> =
  {
    type : "needs-ressources";
    value : {
      ressources : IResource[];
      continue : (loadedRessources : string[]) => IParserResponse<T>;
    };
  } |
  {
    type : "done";
    value : T;
  };

/**
 * @param {Element} root - The MPD root.
 * @param {Object} options
 * @returns {Object}
 */
export default function parseMPD(
  root : Element,
  options : IParseOptions
) : IParserResponse<IParsedManifest> {
  // Transform whole MPD into a parsed JS object representation
  const mpdIR = createMPDIntermediateRepresentation(root);
  return loadExternalRessourcesAndParse(mpdIR, options);
}

/**
 * Checks if xlinks needs to be loaded before actually parsing the manifest.
 * @param {Object} mpdIR
 * @param {Object} options
 * @returns {Object}
 */
function loadExternalRessourcesAndParse(
  mpdIR : IMPDIntermediateRepresentation,
  options : IParseOptions
) : IParserResponse<IParsedManifest> {
  const { manifestURI, loadExternalClock } = options;
  const xlinksToLoad : Array<{ index : number; ressource : string }> = [];
  for (let i = 0; i < mpdIR.children.periods.length; i++) {
    const { xlinkHref, xlinkActuate } = mpdIR.children.periods[i].attributes;
    if (xlinkHref != null && xlinkActuate === "onLoad") {
      xlinksToLoad.push({ index: i, ressource: xlinkHref });
    }
  }

  const utcTimingsToLoad = loadExternalClock ?
    mpdIR.children.utcTimings.filter(utcTiming =>
      utcTiming.schemeIdUri === "urn:mpeg:dash:utc:http-iso:2014") :
    [];

  if (xlinksToLoad.length === 0 && utcTimingsToLoad.length === 0) {
    const parsedManifest = parseCompleteIntermediateRepresentation(mpdIR, manifestURI);
    return { type: "done", value: parsedManifest };
  }

  return {
    type: "needs-ressources",
    value: {
      ressources: [
        ...xlinksToLoad.map<IResource>(
          ({ ressource }) => ({ type: "xlink", url: ressource})
        ),
        ...utcTimingsToLoad.map<IResource>(
          ({ value }) => ({ type: "http-iso", url: value || ""})
        ),
      ],
      continue: function continueParsingMPD(loadedRessources : string[]) {
        if (loadedRessources.length !== (xlinksToLoad.length + utcTimingsToLoad.length)) {
          throw new Error("DASH parser: wrong number of loaded ressources.");
        }

        // Note: It is important to go from the last index to the first index in
        // the resulting array, as we will potentially add elements to the array
        for (let i = xlinksToLoad.length - 1; i >= 0; i--) {
          const index = xlinksToLoad[i].index;
          const xlinkData = loadedRessources[i];
          const wrappedData = "<root>" + xlinkData + "</root>";
          const dataAsXML = new DOMParser().parseFromString(wrappedData, "text/xml");
          if (!dataAsXML || dataAsXML.children.length === 0) {
            throw new Error("DASH parser: Invalid external ressources");
          }
          const periods = dataAsXML.children[0].children;
          const periodsIR : IPeriodIntermediateRepresentation[] = [];
          for (let j = 0; j < periods.length; j++) {
            if (periods[j].nodeType === Node.ELEMENT_NODE) {
              periodsIR.push(createPeriodIntermediateRepresentation(periods[j]));
            }
          }

          // replace original "xlinked" periods by the real deal
          mpdIR.children.periods.splice(index, 1, ...periodsIR);
        }

        for (let j = 0; j < utcTimingsToLoad.length; j++) {
          const utcTiming = utcTimingsToLoad[j];
          utcTiming.schemeIdUri = "urn:mpeg:dash:utc:direct:2014";

          utcTiming.value = loadedRessources[xlinksToLoad.length + j];
        }

        return loadExternalRessourcesAndParse(mpdIR, options);
      },
    },
  };
}

/**
 * Parse the MPD intermediate representation into a regular Manifest.
 * @param {Object} mpdIR
 * @param {string} uri
 * @returns {Object}
 */
function parseCompleteIntermediateRepresentation(
  mpdIR : IMPDIntermediateRepresentation,
  uri : string
) : IParsedManifest {
  const {
    children: rootChildren,
    attributes: rootAttributes,
  } = mpdIR;

  const baseURL = resolveURL(normalizeBaseURL(uri), rootChildren.baseURL);

  const isDynamic : boolean = rootAttributes.type === "dynamic";
  const availabilityStartTime = (
    rootAttributes.type === "static" ||
    rootAttributes.availabilityStartTime == null
  ) ?  0 : rootAttributes.availabilityStartTime;

  const parsedPeriods = parsePeriods(rootChildren.periods, {
    availabilityStartTime,
    duration: rootAttributes.duration,
    isDynamic,
    baseURL,
  });

  const duration : number|undefined = (() => {
    if (rootAttributes.duration != null) {
      return rootAttributes.duration;
    }
    if (isDynamic) {
      return undefined;
    }
    if (parsedPeriods.length) {
      const lastPeriod = parsedPeriods[parsedPeriods.length - 1];
      if (lastPeriod.end != null) {
        return lastPeriod.end;
      } else if (lastPeriod.duration != null) {
        return lastPeriod.start + lastPeriod.duration;
      }
    }
    return undefined;
  })();

  const getClockOffsetFromUTCTimings = (utcTimings: IScheme[]) => {
    const firstDirectUTCTiming = arrayFind(
      utcTimings,
      (utcTiming) => utcTiming.schemeIdUri === "urn:mpeg:dash:utc:direct:2014"
    );

    if (firstDirectUTCTiming && firstDirectUTCTiming.value) {
      try {
        return Date.now() - Date.parse(firstDirectUTCTiming.value);
      } catch (e) {
        log.warn("Failed to parse first direct UTC Timing in dash manifest:", e);
      }
    }

    return undefined;
  };

  const parsedMPD : IParsedManifest = {
    availabilityStartTime,
    baseURL,
    duration,
    id: rootAttributes.id != null ?
      rootAttributes.id : "gen-dash-manifest-" + generateManifestID(),
    periods: parsedPeriods,
    transportType: "dash",
    isLive: isDynamic,
    uris: [uri, ...rootChildren.locations],
    suggestedPresentationDelay: rootAttributes.suggestedPresentationDelay != null ?
      rootAttributes.suggestedPresentationDelay :
      config.DEFAULT_SUGGESTED_PRESENTATION_DELAY.DASH,
    clockOffset: getClockOffsetFromUTCTimings(rootChildren.utcTimings),
  };

  // -- add optional fields --

  if (rootAttributes.type !== "static" && rootAttributes.availabilityEndTime != null) {
    parsedMPD.availabilityEndTime = rootAttributes.availabilityEndTime;
  }
  if (rootAttributes.timeShiftBufferDepth != null) {
    parsedMPD.timeShiftBufferDepth = rootAttributes.timeShiftBufferDepth;
  }
  if (rootAttributes.minimumUpdatePeriod != null
      && rootAttributes.minimumUpdatePeriod > 0) {
    parsedMPD.lifetime = rootAttributes.minimumUpdatePeriod;
  }

  checkManifestIDs(parsedMPD);
  if (parsedMPD.isLive) {
    parsedMPD.presentationLiveGap = getPresentationLiveGap(parsedMPD);
  }
  return parsedMPD;
}
