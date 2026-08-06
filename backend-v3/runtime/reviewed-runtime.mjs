import { VERIFIED_SOIL_V2_CONTRACT } from "../src/adapters/index.js";
import { REVIEWED_CROP_RULES } from "./reviewed-crop-rules.js";
import { REVIEWED_LOCATION_MAPPINGS } from "./reviewed-location-mappings.js";
import {
  KNOWLEDGE_IMAGES,
  REVIEWED_KNOWLEDGE_BASE,
} from "./reviewed-knowledge-base.js";

export async function createRuntimeOptions() {
  return {
    rules: REVIEWED_CROP_RULES,
    verifiedLocationMappings: REVIEWED_LOCATION_MAPPINGS,
    soilContract: VERIFIED_SOIL_V2_CONTRACT,
    knowledgePassages: REVIEWED_KNOWLEDGE_BASE,
    knowledgeImages: KNOWLEDGE_IMAGES,
  };
}
