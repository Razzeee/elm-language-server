/* eslint-disable @typescript-eslint/no-unsafe-call */
import { container } from "tsyringe";
import { Connection, DiagnosticSeverity } from "vscode-languageserver";
import { URI, Utils } from "vscode-uri";
import { ISourceFile } from "../../compiler/forest";
import * as utils from "../../compiler/utils/elmUtils";
import { ElmWorkspaceMatcher } from "../../util/elmWorkspaceMatcher";
import { Settings } from "../../util/settings";
import { IDiagnostic } from "./diagnosticsProvider";
import execa = require("execa");

interface IElmReviewError {
  type: "review-errors";
  errors: IFileError[];
}

interface IFileError {
  path: string;
  errors: IError[];
}

interface IError {
  rule: string;
  ruleLink: string;
  message: string;
  details: string[];
  region: {
    start: IPosition;
    end: IPosition;
  };
  fix: {
    range: {
      start: IPosition;
      end: IPosition;
    };
    string: string;
  }[];
}

interface IPosition {
  line: number;
  column: number;
}

export class ElmReviewDiagnostics {
  private elmWorkspaceMatcher: ElmWorkspaceMatcher<URI>;
  private settings: Settings;
  private connection: Connection;

  constructor() {
    this.settings = container.resolve("Settings");
    this.connection = container.resolve<Connection>("Connection");
    this.elmWorkspaceMatcher = new ElmWorkspaceMatcher((uri) => uri);
  }

  public createDiagnostics = async (
    sourceFile: ISourceFile,
  ): Promise<Map<string, IDiagnostic[]>> => {
    const filePath = URI.parse(sourceFile.uri);
    const workspaceRootPath = this.elmWorkspaceMatcher
      .getProgramFor(filePath)
      .getRootPath();
    return await this.checkForErrors(workspaceRootPath.fsPath);
  };

  private hasType(error: any): error is IElmReviewError {
    return "type" in error;
  }

  private async checkForErrors(
    workspaceRootPath: string,
  ): Promise<Map<string, IDiagnostic[]>> {
    const settings = await this.settings.getClientSettings();

    const args = ["--report", "json"];

    const makeCommand: string = settings.elmPath;
    const elmReviewCommand: string = settings.elmReviewPath;
    const options = {
      cmdArguments: args,
      notFoundText:
        "'elm-review' is not available. Install elm-review via 'npm install -g elm-review'.",
    };

    const fileErrors = new Map<string, IDiagnostic[]>();
    try {
      // Do nothing on success, but return that there were no errors
      utils.execCmdSync(
        elmReviewCommand,
        "elm-review",
        options,
        workspaceRootPath,
        this.connection,
      );
      return fileErrors;
    } catch (error) {
      if (typeof error === "string") {
        return fileErrors;
      } else {
        const execaError = error as execa.ExecaReturnValue<string>;
        let errorObject: unknown;
        try {
          this.connection.console.info(execaError.stdout);
          errorObject = JSON.parse(execaError.stdout);
          this.connection.console.info(JSON.stringify(errorObject));
        } catch (error) {
          this.connection.console.warn(
            "Received an invalid json, skipping error.",
          );
        }

        if (
          errorObject &&
          this.hasType(errorObject) &&
          errorObject.type === "review-errors"
        ) {
          const reviewError = errorObject;
          reviewError.errors.forEach((fileError: IFileError) => {
            const errors: IDiagnostic[] = fileError.errors.map(
              (error: IError) => ({
                message: error.message,
                source: "elm-review",
                range: {
                  start: {
                    character: error.region.start.column - 1,
                    line: error.region.start.line - 1,
                  },
                  end: {
                    character: error.region.end.column - 1,
                    line: error.region.end.line - 1,
                  },
                },
                severity: DiagnosticSeverity.Warning,
                data: {
                  uri: Utils.joinPath(
                    URI.parse(workspaceRootPath),
                    fileError.path,
                  ).toString(),
                  code: "",
                },
              }),
            );

            fileErrors.set(
              Utils.joinPath(
                URI.parse(workspaceRootPath),
                fileError.path,
              ).toString(),
              errors,
            );
          });
        }
        return fileErrors;
      }
    }
  }
}
