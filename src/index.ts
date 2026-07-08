import util from "node:util";

// Surface non-Error throws during development for easier debugging
process.on("uncaughtException", (err) => {
  // err may be a non-Error value, print a full inspection
  // eslint-disable-next-line no-console
  console.error("uncaughtException:", util.inspect(err, { showHidden: true, depth: null }));
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("unhandledRejection:", util.inspect(reason, { showHidden: true, depth: null }));
  process.exit(1);
});

// Wrap startup in async so import-time errors are catchable and logged
async function main() {
  try {
    const [{ default: app }, { logger }] = await Promise.all([
      import("./app.js"),
      import("./lib/logger.js"),
    ]);

    const rawPort = process.env["PORT"] ?? "3000";
    const port = Number(rawPort);
    if (Number.isNaN(port) || port <= 0) {
      throw new Error(`Invalid PORT value: "${rawPort}"`);
    }

    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Startup error:", util.inspect(err, { showHidden: true, depth: null }));
    process.exit(1);
  }
}

main();
