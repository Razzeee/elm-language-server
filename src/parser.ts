import { container } from "tsyringe";
import Parser from "web-tree-sitter";
import { IProgramHost } from "./compiler/program";
import * as path from "path";

export async function loadParser(host: IProgramHost): Promise<void> {
  container.registerSingleton<Parser>("Parser", Parser);
  await Parser.init();
  const absolute = path.join(__dirname, "tree-sitter-elm.wasm");
  const pathToWasm = path.relative(process.cwd(), absolute);
  host.logger.info(`Loading Elm tree-sitter syntax from ${pathToWasm}`);
  const language = await Parser.Language.load(pathToWasm);
  container.resolve<Parser>("Parser").setLanguage(language);
}
