// Production entry: no runtime datasets or private build files.
import handler from "./handler.mjs";
export default {
  fetch(request, env) {
    return handler.fetch(request, env);
  },
};
