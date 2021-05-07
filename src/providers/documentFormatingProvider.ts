import { container, injectable } from "tsyringe";
import {
  DocumentFormattingParams,
  Connection,
  TextEdit,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { DiagnosticsProvider } from ".";
import * as Diff from "../util/diff";
import { execCmdSync } from "../compiler/utils/elmUtils";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";
import { Settings } from "../util/settings";
import { TextDocumentEvents } from "../util/textDocumentEvents";
import { IDocumentFormattingParams } from "./paramsExtensions";
import { createNodeProgramHost } from "../compiler/program";

type DocumentFormattingResult = Promise<TextEdit[] | undefined>;

@injectable()
export class DocumentFormattingProvider {
  private events: TextDocumentEvents;
  private connection: Connection;
  private settings: Settings;
  private diagnostics: DiagnosticsProvider;

  constructor() {
    this.settings = container.resolve<Settings>("Settings");
    this.connection = container.resolve<Connection>("Connection");
    this.events = container.resolve<TextDocumentEvents>(TextDocumentEvents);
    this.diagnostics = container.resolve(DiagnosticsProvider);
    this.connection.onDocumentFormatting(
      this.diagnostics.interruptDiagnostics(() =>
        new ElmWorkspaceMatcher((params: DocumentFormattingParams) =>
          URI.parse(params.textDocument.uri),
        ).handle(this.handleFormattingRequest),
      ),
    );
  }

  private formatText = (
    elmWorkspaceRootPath: URI,
    elmFormatPath: string,
    text: string,
  ): DocumentFormattingResult => {
    const options = {
      cmdArguments: ["--stdin", "--elm-version", "0.19", "--yes"],
      notFoundText: "Install elm-format via 'npm install -g elm-format'.",
    };

    const format = execCmdSync(
      elmFormatPath,
      "elm-format",
      options,
      elmWorkspaceRootPath.fsPath,
      createNodeProgramHost(this.connection),
      text,
    );
    return Diff.getTextRangeChanges(text, format.stdout);
  };

  protected handleFormattingRequest = async (
    params: IDocumentFormattingParams,
  ): DocumentFormattingResult => {
    this.connection.console.info(`Formatting was requested`);
    try {
      const text = this.events.get(params.textDocument.uri);
      if (!text) {
        this.connection.console.error("Can't find file for formatting.");
        return;
      }

      const settings = await this.settings.getClientSettings();
      return this.formatText(
        params.program.getRootPath(),
        settings.elmFormatPath,
        text.getText(),
      );
    } catch (error) {
      this.connection.console.warn(JSON.stringify(error));
      if (
        error?.message &&
        ((error.message as string).includes("SYNTAX PROBLEM") || //Elm-format 0.8.4 and below
          (error.message as string).includes("Unable to parse file")) //Elm-format 0.8.5 and above
      ) {
        this.connection.window.showErrorMessage(
          "Running elm-format failed. Check the file for syntax errors.",
        );
      }
    }
  };
}
