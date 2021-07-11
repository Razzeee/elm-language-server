import { Range } from "vscode-languageserver";
import { TextEdit } from "vscode-languageserver-textdocument";
import { RefactorEditUtils } from "../../util/refactorEditUtils";
import { TreeUtils } from "../../util/treeUtils";
import { Diagnostics } from "../../compiler/diagnostics";
import { CodeActionProvider, ICodeAction } from "../codeActionProvider";
import { ICodeActionParams } from "../paramsExtensions";
import { Utils } from "../../util/utils";

const errorCodes = [Diagnostics.MissingValue.code];
const fixId = "make_external_declaration_from_usage";

CodeActionProvider.registerCodeAction({
  errorCodes,
  fixId,
  getCodeActions: (params: ICodeActionParams) => {
    const allEdits = getEdits(params, params.range);

    return allEdits
      .map(([edits, moduleName]) => {
        if (Object.keys(edits).length > 0) {
          return CodeActionProvider.getCodeAction(
            params,
            `Create function in module '${moduleName}'`,
            edits,
          );
        }
      })
      .filter(Utils.notUndefinedOrNull);
  },
  getFixAllCodeAction: (params: ICodeActionParams): ICodeAction | undefined => {
    return CodeActionProvider.getFixAllCodeAction(
      "Create all missing external functions",
      params,
      errorCodes,
      fixId,
      () => {
        // Not used
      },
      (edits, diagnostic) => {
        const firstEdits = getEdits(params, diagnostic.range)[0];
        if (firstEdits) {
          Utils.mergeChanges(edits, firstEdits[0]);
        }
      },
    );
  },
});

function getEdits(
  params: ICodeActionParams,
  range: Range,
): [{ [uri: string]: TextEdit[] }, string][] {
  const nodeAtPosition = TreeUtils.getNamedDescendantForRange(
    params.sourceFile,
    range,
  );

  if (
    nodeAtPosition.type === "value_qid" &&
    nodeAtPosition.parent?.type === "value_expr"
  ) {
    const funcName = nodeAtPosition.lastNamedChild?.text ?? nodeAtPosition.text;
    const modulePrefix = nodeAtPosition.namedChildren
      .slice(0, -2)
      .map((n) => n.text)
      .join("");

    const checker = params.program.getTypeChecker();

    const moduleNames = checker
      .findImportModuleNameNodes(modulePrefix, params.sourceFile)
      .map((n) => n.text);

    return moduleNames
      .map((moduleName) => {
        const destinationSource =
          params.program.getSourceFileOfImportableModule(
            params.sourceFile,
            moduleName,
          );

        if (destinationSource && destinationSource.writeable) {
          const type = checker.findType(nodeAtPosition);
          const typeString: string = checker.typeToString(
            type,
            params.sourceFile,
          );

          const edit = RefactorEditUtils.createTopLevelFunction(
            destinationSource.tree.rootNode.endPosition.row,
            funcName,
            typeString,
            type.nodeType === "Function" ? type.params.length : 0,
            `Debug.todo "TODO"`,
          );

          const exposeEdit = RefactorEditUtils.exposeValueInModule(
            destinationSource.tree,
            funcName,
          );

          if (edit && exposeEdit) {
            return [
              { [destinationSource.uri]: [edit, exposeEdit] },
              moduleName,
            ] as [{ [uri: string]: TextEdit[] }, string];
          }
        }
      })
      .filter(Utils.notUndefinedOrNull);
  }

  return [];
}
