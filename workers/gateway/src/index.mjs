// Production entry only. A clone without an explicitly prepared local baseline
// cannot bundle; tests use a separate synthetic-only entry. Never commit this JSON.
import bootstrap from "../.local/bootstrap-baseline.json" with { type: "json" };
import handler from "./handler.mjs";
export default {
  fetch(request, env) {
    return handler.fetch(request, env, { bootstrap });
  },
};
