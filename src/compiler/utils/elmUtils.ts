import execa, { ExecaSyncReturnValue } from "execa";
import * as path from "../../util/path";
import { Connection, CompletionItemKind } from "vscode-languageserver";
import { URI } from "vscode-uri";
import { IElmPackageCache } from "../elmPackageCache";
import { IClientSettings } from "../../util/settings";
import { ElmProject, IProgramHost } from "../program";

export const isWindows = process.platform === "win32";

/** Options for execCmdSync */
export interface IExecCmdOptions {
  /** Any arguments */
  cmdArguments?: string[];
  /** Shows a message if an error occurs (in particular the command not being */
  /* found), instead of rejecting. If this happens, the promise never resolves */
  showMessageOnError?: boolean;
  /** Text to add when command is not found (maybe helping how to install) */
  notFoundText?: string;
}

/** Executes a command. Shows an error message if the command isn't found */
export function execCmdSync(
  cmdFromUser: string,
  cmdStatic: string,
  options: IExecCmdOptions = {},
  cwd: string,
  host: IProgramHost,
  input?: string,
): ExecaSyncReturnValue<string> {
  const cmd = cmdFromUser === "" ? cmdStatic : cmdFromUser;
  const preferLocal = cmdFromUser === "";

  const cmdArguments = options ? options.cmdArguments : [];

  try {
    return execa.sync(cmd, cmdArguments, {
      cwd,
      input,
      preferLocal,
      stripFinalNewline: false,
    });
  } catch (error) {
    host.logger.warn(JSON.stringify(error));
    if (error.errno && error.errno === "ENOENT") {
      host.handleError(
        options.notFoundText
          ? options.notFoundText + ` I'm looking for '${cmd}' at '${cwd}'`
          : `Cannot find executable with name '${cmd}'`,
      );
      throw "Executable not found";
    } else {
      throw error;
    }
  }
}

// Special type that has no core mock https://github.com/elm/compiler/blob/51e20357137ebc9c3f6136cf0a3fe21c24027f39/compiler/src/Canonicalize/Environment/Foreign.hs#L62
export function getEmptyTypes(): {
  markdown: string;
  name: string;
  symbolKind: CompletionItemKind;
}[] {
  return [
    {
      markdown: `An \`List\` is a list of items. Every item must be of the same type. Valid syntax for lists includes:

    []
    [42, 43]
    ["one", "two", "three"]
    [3.14, 0.1234]
    ['a', 'Z', '0']

    `,
      name: "List",
      symbolKind: CompletionItemKind.Enum,
    },
  ];
}

export function getElmVersion(
  settings: IClientSettings,
  elmWorkspaceFolder: URI,
  host: IProgramHost,
): string {
  const options = {
    cmdArguments: ["--version"],
    notFoundText:
      "Elm binary not found, did you install and setup the path to your binary?",
  };

  const result = execCmdSync(
    settings.elmPath,
    "elm",
    options,
    elmWorkspaceFolder.fsPath,
    host,
  );

  const version = result.stdout.trim();

  host.logger.info(`Elm version ${version} detected.`);

  return version;
}

type SolverResult =
  | {
      pending: ReadonlyMap<string, IConstraint>;
      solutions: ReadonlyMap<string, IVersion>;
    }
  | undefined;

export async function solveDependencies(
  packageCache: IElmPackageCache,
  deps: ReadonlyMap<string, IConstraint>,
): Promise<ReadonlyMap<string, IVersion> | undefined> {
  const result = await solveDependenciesWorker(
    packageCache,
    deps,
    new Map<string, IVersion>(),
  );

  if (result) {
    return result.solutions;
  }
}

async function solveDependenciesWorker(
  packageCache: IElmPackageCache,
  deps: ReadonlyMap<string, IConstraint>,
  solutions: ReadonlyMap<string, IVersion>,
): Promise<SolverResult> {
  function pickDep(): [
    { name: string; constraint: IConstraint } | undefined,
    Map<string, IConstraint>,
  ] {
    const restDeps = new Map(deps);
    const firstDep = Array.from(deps.keys()).sort()[0];

    restDeps.delete(firstDep);

    return [
      firstDep && deps.has(firstDep)
        ? { name: firstDep, constraint: deps.get(firstDep)! }
        : undefined,
      restDeps,
    ];
  }

  function combineDeps(
    a: ReadonlyMap<string, IConstraint>,
    b: ReadonlyMap<string, IConstraint>,
  ): Map<string, IConstraint> | undefined {
    const deps = new Map<string, IConstraint>();
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const v1 = a.get(key);
      const v2 = b.get(key);

      if (v1 && v2) {
        const intersect = constraintIntersect(v1, v2);

        if (!intersect) {
          return;
        }

        deps.set(key, intersect);
      } else if (v1) {
        deps.set(key, v1);
      } else if (v2) {
        deps.set(key, v2);
      } else {
        throw new Error("impossible");
      }
    }

    return deps;
  }

  const [dep, restDeps] = pickDep();

  if (!dep) {
    return { pending: deps, solutions };
  }

  // Find versions that satisfy the constraint
  let candidates = (await packageCache.getVersions(dep.name))
    .filter((version) => versionSatifiesConstraint(version, dep.constraint))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .reverse();

  const solvedVersion = solutions.get(dep.name);

  if (solvedVersion) {
    candidates = candidates.filter((a) => a.string === solvedVersion.string);
  }

  for (const candidate of candidates) {
    const candidateDeps = await packageCache.getDependencies(
      dep.name,
      candidate,
    );
    const tentativeDeps = combineDeps(restDeps, candidateDeps);

    if (!tentativeDeps) {
      continue;
    }

    const tentativeSolutions = new Map(solutions);
    tentativeSolutions.set(dep.name, candidate);

    const result = await solveDependenciesWorker(
      packageCache,
      tentativeDeps,
      tentativeSolutions,
    );

    if (result) {
      return solveDependenciesWorker(
        packageCache,
        result.pending,
        result.solutions,
      );
    }
  }
}

export interface IVersion {
  major: number;
  minor: number;
  patch: number;
  string: string;
}

export interface IConstraint {
  upper: IVersion;
  lower: IVersion;
  upperOperator: "<" | "<=";
  lowerOperator: "<" | "<=";
}

export function parseVersion(version: string): IVersion {
  const [major, minor, patch] = version.split(".");

  return {
    major: parseInt(major),
    minor: parseInt(minor),
    patch: parseInt(patch),
    string: version,
  };
}

export function parseConstraint(contraint: string): IConstraint {
  const regex = /^(\d+\.\d+\.\d+) (<|<=) v (<|<=) (\d+\.\d+\.\d+)$/gm;

  const m = regex.exec(contraint);
  if (m) {
    const lowerRange = m[1];
    const lowerOperator = m[2];
    const upperOperator = m[3];
    const upperRange = m[4];

    return {
      lower: parseVersion(lowerRange),
      upper: parseVersion(upperRange),
      lowerOperator: lowerOperator as "<" | "<=",
      upperOperator: upperOperator as "<" | "<=",
    };
  }

  throw new Error("Could not parse version constraint");
}

export function versionSatifiesConstraint(
  version: IVersion,
  constraint: IConstraint,
): boolean {
  return (
    filterSemver(constraint.lower, version, constraint.lowerOperator) &&
    filterSemver(version, constraint.upper, constraint.upperOperator)
  );
}

function filterSemver(
  lower: IVersion,
  upper: IVersion,
  operator: "<" | "<=",
): boolean {
  const currentCompare = versionCompare(lower, upper);
  switch (operator) {
    case "<=":
      return currentCompare === -1 || currentCompare === 0;
    case "<":
      return currentCompare === -1;
  }
}

function versionCompare(a: IVersion, b: IVersion): number {
  const pa = a.string.split(".");
  const pb = b.string.split(".");
  for (let i = 0; i < 3; i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (na > nb) {
      return 1;
    }
    if (nb > na) {
      return -1;
    }
  }
  return 0;
}

export function constraintIntersect(
  a: IConstraint,
  b: IConstraint,
): IConstraint | undefined {
  function merge(op1: "<=" | "<", op2: "<=" | "<"): "<=" | "<" {
    return op1 === "<" || op2 === "<" ? "<" : "<=";
  }

  let newLower;
  let newLowerOp;
  let newUpper;
  let newUpperOp;

  const lowerCompare = versionCompare(a.lower, b.lower);

  switch (lowerCompare) {
    case -1:
      newLower = b.lower;
      newLowerOp = b.lowerOperator;
      break;
    case 0:
      newLower = a.lower;
      newLowerOp = merge(a.lowerOperator, b.lowerOperator);
      break;
    case 1:
      newLower = a.lower;
      newLowerOp = a.lowerOperator;
      break;
  }

  const upperCompare = versionCompare(a.upper, b.upper);

  switch (upperCompare) {
    case -1:
      newUpper = a.upper;
      newUpperOp = a.upperOperator;
      break;
    case 0:
      newUpper = a.upper;
      newUpperOp = merge(a.upperOperator, b.upperOperator);
      break;
    case 1:
      newUpper = b.upper;
      newUpperOp = b.upperOperator;
      break;
  }

  if (
    !newLower ||
    !newUpper ||
    !newLowerOp ||
    !newUpperOp ||
    versionCompare(newLower, newUpper) !== -1
  ) {
    return;
  }

  return {
    lower: newLower,
    upper: newUpper,
    lowerOperator: newLowerOp,
    upperOperator: newUpperOp,
  };
}

export function getModuleName(uri: string, sourceDir: string): string {
  return path.relative(sourceDir, uri).replace(".elm", "").split("/").join(".");
}

export function flattenExposedModules(
  exposedModules: string[] | { [name: string]: string[] },
): string[] {
  if (Array.isArray(exposedModules)) {
    return exposedModules;
  }

  return Object.values(exposedModules).flatMap((a) => a);
}

export function nameIsKernel(name: string): boolean {
  return name.startsWith("Elm.Kernel.");
}

export function isKernelProject(project: ElmProject): boolean {
  if (project.type === "package") {
    const author = project.maintainerAndPackageName.split("/")[0];
    return author === "elm" || author === "elm-explorations";
  }

  return false;
}

export function isCoreProject(project: ElmProject): boolean {
  return (
    project.type === "package" &&
    project.maintainerAndPackageName === "elm/core"
  );
}
