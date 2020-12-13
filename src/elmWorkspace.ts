import fs, { readdirSync } from "fs";
import globby from "globby";
import os from "os";
import path from "path";
import { container } from "tsyringe";
import util from "util";
import { Connection } from "vscode-languageserver";
import { URI } from "vscode-uri";
import Parser, { Tree } from "web-tree-sitter";
import { ICancellationToken } from "./cancellation";
import { Forest, IForest, ITreeContainer } from "./forest";
import { UriString } from "./uri";
import * as utils from "./util/elmUtils";
import {
  IPossibleImportsCache,
  PossibleImportsCache,
} from "./util/possibleImportsCache";
import { Settings } from "./util/settings";
import { Diagnostic } from "./util/types/diagnostics";
import { TypeCache } from "./util/types/typeCache";
import {
  createTypeChecker,
  DefinitionResult,
  TypeChecker,
} from "./util/types/typeChecker";

const readFile = util.promisify(fs.readFile);

interface IElmFile {
  path: string;
  maintainerAndPackageName?: string;
  project: ElmProject;
}

type ElmJson = IElmApplicationJson | IElmPackageJson;

interface IElmApplicationJson {
  type: "application";
  "source-directories": string[];
  "elm-version": string;
  dependencies: {
    direct: {
      [module: string]: string;
    };
    indirect: {
      [module: string]: string;
    };
  };
  "test-dependencies": {
    direct: {
      [module: string]: string;
    };
    indirect: {
      [module: string]: string;
    };
  };
}

interface IElmPackageJson {
  type: "package";
  name: string;
  summary: string;
  license: string;
  version: string;
  "exposed-modules": string[] | { [name: string]: string[] };
  "elm-version": string;
  dependencies: {
    [module: string]: string;
  };
  "test-dependencies": {
    [module: string]: string;
  };
}

export interface IElmWorkspace {
  init(progressCallback: (percent: number) => void): void;
  hasDocument(uri: URI): boolean;
  hasPath(uri: URI): boolean;
  getPath(uri: URI): string | undefined;
  getSourceFile(uri: URI): ITreeContainer | undefined;
  getForest(synchronize?: boolean): IForest;
  getRootPath(): URI;
  getTypeCache(): TypeCache;
  getTypeChecker(): TypeChecker;
  markAsDirty(): void;
  getPossibleImportsCache(): IPossibleImportsCache;
  getOperatorsCache(): Map<string, DefinitionResult>;
  getSemanticDiagnostics(
    sourceFile: ITreeContainer,
    cancellationToken?: ICancellationToken,
  ): Diagnostic[];
  getSemanticDiagnosticsAsync(
    sourceFile: ITreeContainer,
    cancellationToken?: ICancellationToken,
  ): Promise<Diagnostic[]>;
  getSyntacticDiagnostics(sourceFile: ITreeContainer): Diagnostic[];
  getSuggestionDiagnostics(
    sourceFile: ITreeContainer,
    cancellationToken?: ICancellationToken,
  ): Diagnostic[];
  hasAccessibleModule(moduleName: string): boolean;
}

export type ElmProject = IElmApplication | IElmPackage;

interface IElmProject {
  type: string;
  uri: URI;
  dependencies: Map<string, IElmPackage>;
  testDependencies: Map<string, IElmPackage>;
  sourceDirectories: string[];
  testDirectories: string[];
  moduleToUriMap: Map<string, URI>;
}

interface IElmApplication extends IElmProject {
  type: "application";
}

interface IElmPackage extends IElmProject {
  type: "package";
  maintainerAndPackageName: string;
  exposedModules: Set<string>;
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

export interface IPackage {
  dependencies: Map<string, IConstraint>;
  version: IVersion;
}

export interface IElmPackageCache {
  get(packageName: string): IPackage[];
}

export class ElmPackageCache implements IElmPackageCache {
  private cache = new Map<string, IPackage[]>();

  constructor(
    private packagesRoot: string,
    private loadElmJson: (elmJsonPath: string) => ElmJson,
  ) {}

  public get(packageName: string): IPackage[] {
    const cached = this.cache.get(packageName);

    if (cached) {
      return cached;
    }

    const maintainer = packageName.substring(0, packageName.indexOf("/"));
    const name = packageName.substring(
      packageName.indexOf("/") + 1,
      packageName.length,
    );

    const pathToPackage = `${this.packagesRoot}${maintainer}/${name}/`;
    const readDir = readdirSync(pathToPackage, "utf8");

    const allVersions: IPackage[] = [];

    for (const folderName of readDir) {
      const version = utils.parseVersion(folderName);

      if (
        Number.isInteger(version.major) &&
        Number.isInteger(version.minor) &&
        Number.isInteger(version.patch)
      ) {
        const elmJsonPath = path.join(pathToPackage, folderName, "elm.json");
        const elmJson = this.loadElmJson(elmJsonPath);

        allVersions.push({
          version,
          dependencies: new Map(
            Object.entries(elmJson.dependencies).map(([name, constraint]) => [
              name,
              utils.parseContraint(constraint),
            ]),
          ),
        });
      }
    }

    this.cache.set(packageName, allVersions);

    return allVersions;
  }
}

interface IProgramHost {
  readFile(uri: URI): Promise<string>;
  readFileSync(uri: URI): string;
  readDirectory(uri: URI): Promise<URI[]>;
}

export class ElmWorkspace implements IElmWorkspace {
  private parser: Parser;
  private connection: Connection;
  private settings: Settings;
  private typeCache: TypeCache;
  private typeChecker: TypeChecker | undefined;
  private dirty = true;
  private possibleImportsCache: IPossibleImportsCache;
  private operatorsCache: Map<string, DefinitionResult>;
  private diagnosticsCache: Map<URI, Diagnostic[]>;
  private rootProject!: ElmProject;
  private packagesRoot!: string;
  private forest!: IForest;
  private elmPackageCache!: IElmPackageCache;
  private resolvedPackageCache = new Map<string, IElmPackage>();
  private host: IProgramHost;

  constructor(private rootPath: URI, programHost?: IProgramHost) {
    this.settings = container.resolve("Settings");
    this.connection = container.resolve("Connection");
    this.parser = container.resolve("Parser");
    this.connection.console.info(
      `Starting language server for folder: ${this.rootPath.toString()}`,
    );

    this.typeCache = new TypeCache();
    this.possibleImportsCache = new PossibleImportsCache();
    this.operatorsCache = new Map<string, DefinitionResult>();
    this.diagnosticsCache = new Map<URI, Diagnostic[]>();
    this.host = programHost ?? this.createProgramHost();
  }

  public async init(
    progressCallback: (percent: number) => void,
  ): Promise<void> {
    await this.initWorkspace(progressCallback);
  }

  public hasDocument(uri: URI): boolean {
    return !!this.forest.getTree(uri);
  }

  public hasPath(uri: URI): boolean {
    return !!this.getPath(uri);
  }

  public getPath(uri: URI): string | undefined {
    return [
      ...this.rootProject.sourceDirectories,
      ...this.rootProject.testDirectories,
    ].find((elmFolder) => uri.fsPath.startsWith(elmFolder));
  }

  public getSourceFile(uri: URI): ITreeContainer | undefined {
    return this.getForest().getByUri(uri);
  }

  public getForest(synchronize = true): IForest {
    if (this.dirty && synchronize) {
      this.forest.synchronize();
      this.dirty = false;
    }

    return this.forest;
  }

  public getRootPath(): URI {
    return this.rootPath;
  }

  public getTypeCache(): TypeCache {
    return this.typeCache;
  }

  public getTypeChecker(): TypeChecker {
    if (this.dirty) {
      this.forest.synchronize();
      this.dirty = false;
    }

    return this.typeChecker ?? (this.typeChecker = createTypeChecker(this));
  }

  public markAsDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      this.typeChecker = undefined;
      this.diagnosticsCache.clear();
    }
  }

  public getPossibleImportsCache(): IPossibleImportsCache {
    return this.possibleImportsCache;
  }

  public getOperatorsCache(): Map<string, DefinitionResult> {
    return this.operatorsCache;
  }

  public getSemanticDiagnostics(
    sourceFile: ITreeContainer,
    cancellationToken?: ICancellationToken,
  ): Diagnostic[] {
    const cached = this.diagnosticsCache.get(sourceFile.uri);

    if (cached) {
      return cached;
    }

    const diagnostics = this.getTypeChecker().getDiagnostics(
      sourceFile,
      cancellationToken,
    );

    this.diagnosticsCache.set(sourceFile.uri, diagnostics);
    return diagnostics;
  }

  public async getSemanticDiagnosticsAsync(
    sourceFile: ITreeContainer,
    cancellationToken?: ICancellationToken,
  ): Promise<Diagnostic[]> {
    const cached = this.diagnosticsCache.get(sourceFile.uri);

    if (cached) {
      return Promise.resolve(cached);
    }

    const diagnostics = await this.getTypeChecker().getDiagnosticsAsync(
      sourceFile,
      cancellationToken,
    );

    this.diagnosticsCache.set(sourceFile.uri, diagnostics);
    return diagnostics;
  }

  public getSyntacticDiagnostics(sourceFile: ITreeContainer): Diagnostic[] {
    // Getting the type checker will bind the file if its not
    this.getTypeChecker();
    return sourceFile.parseDiagnostics;
  }

  public getSuggestionDiagnostics(
    sourceFile: ITreeContainer,
    cancellationToken?: ICancellationToken,
  ): Diagnostic[] {
    return this.getTypeChecker().getSuggestionDiagnostics(
      sourceFile,
      cancellationToken,
    );
  }

  public hasAccessibleModule(moduleName: string): boolean {
    return this.rootProject.moduleToUriMap.has(moduleName);
  }

  private async initWorkspace(
    progressCallback: (percent: number) => void,
  ): Promise<void> {
    const clientSettings = await this.settings.getClientSettings();
    let progress = 0;
    let elmVersion;
    try {
      elmVersion = await utils.getElmVersion(
        clientSettings,
        this.rootPath,
        this.connection,
      );
    } catch (e) {
      this.connection.console.warn(
        `Could not figure out elm version, this will impact how good the server works. \n ${e.stack}`,
      );
    }

    const pathToElmJson = path.join(this.rootPath.fsPath, "elm.json");
    this.connection.console.info(`Reading elm.json from ${pathToElmJson}`);

    try {
      const elmHome = this.findElmHome();
      this.packagesRoot = `${elmHome}/${elmVersion}/${this.packageOrPackagesFolder(
        elmVersion,
      )}/`;

      this.elmPackageCache = new ElmPackageCache(
        this.packagesRoot,
        this.loadElmJson.bind(this),
      );
      this.rootProject = await this.loadRootProject(pathToElmJson);
      this.forest = new Forest(this.rootProject);

      const elmFilePaths = await this.findElmFilesInProject(this.rootProject);
      this.connection.console.info(
        `Found ${elmFilePaths.length.toString()} files to add to the project`,
      );

      if (elmFilePaths.every((a) => a.project !== this.rootProject)) {
        this.connection.window.showErrorMessage(
          "The path or paths you entered in the 'source-directories' field of your 'elm.json' does not contain any elm files.",
        );
      }

      const promiseList: Promise<void>[] = [];
      const PARSE_STAGES = 3;
      const progressDelta = 100 / (elmFilePaths.length * PARSE_STAGES);
      for (const filePath of elmFilePaths) {
        progressCallback((progress += progressDelta));
        promiseList.push(
          this.readAndAddToForest(filePath, () => {
            progressCallback((progress += progressDelta));
          }),
        );
      }
      await Promise.all(promiseList);

      this.findExposedModulesOfDependencies(this.rootProject);

      this.connection.console.info(
        `Done parsing all files for ${pathToElmJson}`,
      );
    } catch (error) {
      this.connection.console.error(
        `Error parsing files for ${pathToElmJson}:\n${error.stack}`,
      );
    }
  }

  private async loadRootProject(elmJsonPath: string): Promise<ElmProject> {
    const elmJson = this.loadElmJson(elmJsonPath);

    if (elmJson.type === "application") {
      const allDependencies = new Map(
        Object.entries(
          Object.assign(
            elmJson.dependencies.direct,
            elmJson.dependencies.indirect,
            elmJson["test-dependencies"].direct,
            elmJson["test-dependencies"].indirect,
          ),
        ).map(([dep, version]) => [dep, utils.parseVersion(version)]),
      );

      return {
        type: "application",
        uri: this.rootPath,
        sourceDirectories: elmJson["source-directories"].map((folder) =>
          path.resolve(this.rootPath.fsPath, folder),
        ),
        testDirectories: [path.join(this.rootPath.fsPath, "tests")],
        dependencies: await this.loadDependencyMap(
          elmJson.dependencies.direct,
          allDependencies,
        ),
        testDependencies: await this.loadDependencyMap(
          elmJson["test-dependencies"].direct,
          allDependencies,
        ),
        moduleToUriMap: new Map<string, URI>(),
      } as IElmApplication;
    } else {
      const deps = new Map(
        Object.entries(
          Object.assign(elmJson.dependencies, elmJson["test-dependencies"]),
        ).map(([dep, version]) => [dep, utils.parseContraint(version)]),
      );

      const solvedVersions = utils.solveDependencies(
        this.elmPackageCache,
        deps,
      );

      if (!solvedVersions) {
        throw new Error("Unsolvable package constraints");
      }

      return {
        type: "package",
        uri: this.rootPath,
        sourceDirectories: [path.join(this.rootPath.fsPath, "src")],
        testDirectories: [path.join(this.rootPath.fsPath, "tests")],
        dependencies: await this.loadDependencyMap(
          elmJson.dependencies,
          solvedVersions,
        ),
        testDependencies: await this.loadDependencyMap(
          elmJson["test-dependencies"],
          solvedVersions,
        ),
        exposedModules: new Set(
          this.flatternExposedModules(elmJson["exposed-modules"]),
        ),
        moduleToUriMap: new Map<string, URI>(),
      } as IElmPackage;
    }
  }

  private async loadPackage(
    packageName: string,
    packageVersions: ReadonlyMap<string, IVersion>,
  ): Promise<IElmPackage> {
    const version = packageVersions.get(packageName);

    if (!version) {
      throw new Error("Problem getting package version");
    }

    // Version shouldn't be necessary, but it won't hurt
    const cacheKey = `${packageName}@${version.string}`;
    const cached = this.resolvedPackageCache.get(cacheKey);
    if (cached) {
      return Promise.resolve(cached);
    }

    const maintainer = packageName.substring(0, packageName.indexOf("/"));
    const name = packageName.substring(
      packageName.indexOf("/") + 1,
      packageName.length,
    );

    const pathToPackageWithVersion = `${this.packagesRoot}${maintainer}/${name}/${version.string}`;

    const elmJsonPath = path.join(pathToPackageWithVersion, "elm.json");
    const elmJson = this.loadElmJson(elmJsonPath);

    if (elmJson.type === "package") {
      const resolvedPackage = {
        type: "package",
        uri: URI.parse(pathToPackageWithVersion),
        sourceDirectories: [path.join(pathToPackageWithVersion, "src")],
        testDirectories: [path.join(pathToPackageWithVersion, "tests")],
        dependencies: await this.loadDependencyMap(
          elmJson.dependencies,
          packageVersions,
        ),
        testDependencies: new Map<string, IElmPackage>(),
        exposedModules: new Set(
          this.flatternExposedModules(elmJson["exposed-modules"]),
        ),
        moduleToUriMap: new Map<string, URI>(),
      } as IElmPackage;

      this.resolvedPackageCache.set(cacheKey, resolvedPackage);
      return resolvedPackage;
    } else {
      throw new Error("Should never happen");
    }
  }

  private async loadDependencyMap(
    deps: {
      [module: string]: string;
    },
    packageVersions: ReadonlyMap<string, IVersion>,
  ): Promise<Map<string, IElmPackage>> {
    const dependencyMap = new Map();
    for (const dep in deps) {
      dependencyMap.set(dep, await this.loadPackage(dep, packageVersions));
    }
    return dependencyMap;
  }

  /**
   * Get all unique source directories from project dependency tree
   */
  private getSourceDirectories(
    project: ElmProject,
  ): Map<UriString, ElmProject> {
    const sourceDirs = new Map(
      [
        ...project.sourceDirectories,
        ...(project === this.rootProject ? project.testDirectories : []),
      ].map((sourceDir) => [URI.parse(sourceDir).toString(), project]),
    );

    project.dependencies.forEach((dep) =>
      this.getSourceDirectories(dep).forEach((project, sourceDir) =>
        sourceDirs.set(sourceDir, project),
      ),
    );

    if (project === this.rootProject) {
      project.testDependencies.forEach((dep) =>
        this.getSourceDirectories(dep).forEach((project, sourceDir) =>
          sourceDirs.set(sourceDir, project),
        ),
      );
    }

    return sourceDirs;
  }

  private async findElmFilesInProject(
    project: ElmProject,
  ): Promise<IElmFile[]> {
    const elmFilePathPromises: Promise<IElmFile[]>[] = [];

    this.getSourceDirectories(project).forEach((project, sourceDir) => {
      elmFilePathPromises.push(
        this.findElmFilesInProjectWorker(URI.parse(sourceDir), project),
      );
    });

    return (await Promise.all(elmFilePathPromises)).reduce(
      (a, b) => a.concat(b),
      [],
    );
  }

  private async findElmFilesInProjectWorker(
    sourceDir: URI,
    project: ElmProject,
  ): Promise<IElmFile[]> {
    const elmFiles: IElmFile[] = [];

    const maintainerAndPackageName =
      project.type === "package" ? project.maintainerAndPackageName : undefined;

    this.connection.console.info(`Glob ${sourceDir}/**/*.elm`);

    (await this.host.readDirectory(sourceDir)).forEach((matchingPath) => {
      const moduleName = path
        .relative(sourceDir.fsPath, matchingPath.fsPath)
        .replace(".elm", "")
        .split("\\")
        .join(".");

      project.moduleToUriMap.set(moduleName, matchingPath);

      elmFiles.push({
        maintainerAndPackageName,
        path: matchingPath.fsPath,
        project,
      });
    });

    return elmFiles;
  }

  private flatternExposedModules(
    exposedModules: string[] | { [name: string]: string[] },
  ): string[] {
    if (Array.isArray(exposedModules)) {
      return exposedModules;
    }

    return Object.values(exposedModules).reduce((a, b) => a.concat(b), []);
  }

  private packageOrPackagesFolder(elmVersion: string | undefined): string {
    return elmVersion === "0.19.0" ? "package" : "packages";
  }

  private findElmHome(): string {
    const elmHomeVar = process.env.ELM_HOME;

    if (elmHomeVar) {
      return elmHomeVar;
    }

    return utils.isWindows
      ? `${os.homedir()}/AppData/Roaming/elm`
      : `${os.homedir()}/.elm`;
  }

  private async readAndAddToForest(
    filePath: IElmFile,
    callback: () => void,
  ): Promise<void> {
    try {
      this.connection.console.info(`Adding ${filePath.path.toString()}`);
      const fileContent: string = await this.host.readFile(
        URI.parse(filePath.path),
      );

      const tree: Tree = this.parser.parse(fileContent);
      this.forest.setTree(
        URI.parse(filePath.path),
        filePath.project === this.rootProject,
        true,
        tree,
        filePath.project,
        filePath.maintainerAndPackageName,
      );
      callback();
    } catch (error) {
      this.connection.console.error(error.stack);
    }
  }

  private findExposedModulesOfDependencies(project: ElmProject): void {
    const loadForDependencies = (deps: Map<string, IElmPackage>): void => {
      // For each dependecy, find every exposed module
      deps.forEach((dep) => {
        dep.moduleToUriMap.forEach((uri, module) => {
          if (dep.exposedModules.has(module)) {
            project.moduleToUriMap.set(module, uri);
          }
        });
        this.findExposedModulesOfDependencies(dep);
      });
    };

    loadForDependencies(project.dependencies);

    if (project === this.rootProject) {
      loadForDependencies(project.testDependencies);
    }
  }

  private loadElmJson(elmJsonPath: string): ElmJson {
    return JSON.parse(
      this.host.readFileSync(URI.parse(elmJsonPath)),
    ) as ElmJson;
  }

  private createProgramHost(): IProgramHost {
    return {
      readFile: (uri): Promise<string> =>
        readFile(uri.fsPath, {
          encoding: "utf-8",
        }),
      readFileSync: (uri): string =>
        fs.readFileSync(uri.fsPath, {
          encoding: "utf-8",
        }),
      readDirectory: (uri: URI): Promise<URI[]> =>
        // Cleanup the path on windows, as globby does not like backslashes
        globby(`${uri.fsPath.replace(/\\/g, "/")}/**/*.elm`, {
          suppressErrors: true,
        }).then((a) => a.map((a) => URI.parse(a))),
    };
  }
}
