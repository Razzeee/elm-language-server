#!/usr/bin/env node

import * as Path from "path";
import "reflect-metadata";
import { container } from "tsyringe"; //must be after reflect-metadata
import {
  Connection,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
} from "vscode-languageserver";
import { createConnection } from "vscode-languageserver/node";
import Parser from "web-tree-sitter";
import { getCancellationStrategyFromArgv } from "./cancellation";
import { CapabilityCalculator } from "./capabilityCalculator";
import { createNodeProgramHost } from "./compiler/program";
import { loadParser } from "./parser";
import { ASTProvider } from "./providers";
import {
  ElmAnalyseJsonService,
  IElmAnalyseJsonService,
} from "./providers/diagnostics/elmAnalyseJsonService";
import { ILanguageServer } from "./server";
import { DocumentEvents } from "./util/documentEvents";
import { Settings } from "./util/settings";
import { TextDocumentEvents } from "./util/textDocumentEvents";

// Show version for `-v` or `--version` arguments
if (process.argv[2] === "-v" || process.argv[2] === "--version") {
  // require is used to avoid loading package if not necessary (~30ms time difference)
  process.stdout.write(`${require("pjson").version}\n`);
  process.exit(0);
}

// default argument `--stdio`
if (process.argv.length === 2) {
  process.argv.push("--stdio");
}

// Composition root - be aware, there are some register calls that need to be done later
container.register<Connection>("Connection", {
  useValue: createConnection(ProposedFeatures.all, {
    cancellationStrategy: getCancellationStrategyFromArgv(process.argv),
  }),
});

container.registerSingleton("DocumentEvents", DocumentEvents);
container.registerSingleton<IElmAnalyseJsonService>(
  "ElmAnalyseJsonService",
  ElmAnalyseJsonService,
);
container.register(TextDocumentEvents, {
  useValue: new TextDocumentEvents(),
});

const connection = container.resolve<Connection>("Connection");

let server: ILanguageServer;

connection.onInitialize(
  async (
    params: InitializeParams,
    cancel,
    progress,
  ): Promise<InitializeResult> => {
    await loadParser(createNodeProgramHost(connection));

    container.register(CapabilityCalculator, {
      useValue: new CapabilityCalculator(params.capabilities),
    });

    const initializationOptions = params.initializationOptions ?? {};

    container.register("Settings", {
      useValue: new Settings(initializationOptions, params.capabilities),
    });

    const { Server } = await import("./server");
    server = new Server(params, progress);
    await server.init();

    container.register(ASTProvider, {
      useValue: new ASTProvider(),
    });

    return server.capabilities;
  },
);

connection.onInitialized(() => {
  server.registerInitializedProviders();
});

// Listen on the connection
connection.listen();

// Don't die on unhandled Promise rejections
process.on("unhandledRejection", (reason, p) => {
  connection.console.error(
    `Unhandled Rejection at: Promise ${p} reason:, ${reason}`,
  );
});
