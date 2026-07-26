import { VERIFIED_SOIL_V2_CONTRACT } from "../src/adapters/index.js";
import { REVIEWED_CROP_RULES } from "./reviewed-crop-rules.js";
import { REVIEWED_LOCATION_MAPPINGS } from "./reviewed-location-mappings.js";

export async function createRuntimeOptions() {
  return {
    rules: REVIEWED_CROP_RULES,
    verifiedLocationMappings: REVIEWED_LOCATION_MAPPINGS,
    soilContract: VERIFIED_SOIL_V2_CONTRACT,
  };
}
