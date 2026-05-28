#!/usr/bin/env node
/** The `throttlekit` bin entry. Just runs {@link main}; everything else lives in `./index`. */
import { main } from "./index";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
