import snapshot from "../../../scripts/snapshot-policy.json" with { type: "json" };
import config from "../../../config.json" with { type: "json" };
export const policy = { ...snapshot, lineageGroups: config.lineageGroups };
