// Local workerd entry only; never deploy this synthetic fixture.
import handler from "../src/handler.mjs";
import { bootstrap, policy } from "./synthetic-bootstrap.mjs";
export default {
  fetch(request, env) {
    return handler.fetch(request, env, { bootstrap, policy });
  },
};
