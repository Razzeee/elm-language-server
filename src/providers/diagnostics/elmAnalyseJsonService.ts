import path from "path";
import { container, injectable } from "tsyringe";
import { Connection } from "vscode-languageserver";

export interface IElmAnalyseJson {
  checks?: {
    BooleanCase?: boolean;
    DebugLog?: boolean; // We don't support this
    DebugTodo?: boolean; // We don't support this
    DropConcatOfLists?: boolean;
    DropConsOfItemAndList?: boolean;
    DuplicateImport?: boolean; // We don't support this as elm-format will fix this
    DuplicateImportedVariable?: boolean; // We don't support this as elm-format will fix this
    ExposeAll?: boolean; // We don't support this
    FileLoadFailed?: boolean; // We don't support this as it makes no sense for us
    NoUncurriedPrefix?: boolean;
    FunctionInLet?: boolean; // We don't support this
    ImportAll?: boolean; // We don't support this
    MapNothingToNothing?: boolean;
    MultiLineRecordFormatting?: boolean; // We don't support this
    NoTopLevelSignature?: boolean; // We don't support this as we get it via type inference already
    SingleFieldRecord?: boolean;
    TriggerWords?: string[]; // We don't support this
    UnnecessaryListConcat?: boolean;
    UnnecessaryParens?: boolean; // We don't support this as elm-format will fix these anyway
    UnnecessaryPortModule?: boolean;
    UnusedImport?: boolean;
    UnusedImportAlias?: boolean;
    UnusedImportedVariable?: boolean;
    UnusedPatternVariable?: boolean;
    UnusedTopLevel?: boolean;
    UnusedTypeAlias?: boolean;
    UnusedValueConstructor?: boolean;
    UnusedVariable?: boolean;
    UseConsOverConcat?: boolean;
    MissingTypeAnnotation?: boolean;
  };
  excludedPaths?: string[];
}

export interface IElmAnalyseJsonService {
  getElmAnalyseJson(workspacePath: string): IElmAnalyseJson;
}

@injectable()
export class ElmAnalyseJsonService implements IElmAnalyseJsonService {
  private connection: Connection;
  private elmAnalyseJson = new Map<string, IElmAnalyseJson>();

  constructor() {
    this.connection = container.resolve<Connection>("Connection");
  }

  public getElmAnalyseJson(workspacePath: string): IElmAnalyseJson {
    const cached = this.elmAnalyseJson.get(workspacePath);

    if (cached) {
      return cached;
    }

    let elmAnalyseJson = {};
    try {
      elmAnalyseJson = require(path.join(
        workspacePath,
        "elm-analyse.json",
      )) as IElmAnalyseJson;
    } catch {
      this.connection.console.info(
        "No elm-analyse.json found, enabling all diagnostic checks.",
      );
    }

    this.elmAnalyseJson.set(workspacePath, elmAnalyseJson);
    return elmAnalyseJson;
  }
}
