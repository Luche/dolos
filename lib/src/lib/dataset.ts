import { readFiles, readPath } from "./reader.js";
import { convertFile } from "./fileConverter.js";

import { ExtraInfo, File, Result } from "@dodona/dolos-core";
import { csvParse, DSVRowString } from "d3-dsv";

import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync as spawn } from "node:child_process";
import { tmpdir } from "node:os";

const CODE_EXTENSIONS = new Set([
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".hxx",
  ".cs", ".csx",
  ".py", ".py3", ".ipynb",
  ".java",
  ".js", ".ts", ".tsx",
  ".php", ".php3", ".php4", ".php5", ".php7", ".phtml",
  ".go", ".rs", ".rlib",
  ".sh", ".bash",
  ".r", ".scala", ".sc",
  ".elm", ".groovy", ".gvy", ".gy", ".gsh",
  ".v", ".vh", ".mo", ".mos", ".ml", ".sql",
]);

const IGNORED_EXTENSIONS = new Set([
  ".exe", ".out", ".class", ".o", ".obj", ".dll", ".so",
  ".doc", ".docx", ".pdf", ".html", ".htm",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg",
  ".zip", ".rar", ".tar", ".gz", ".7z",
]);

function isCodeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

export class Dataset {
  constructor(
      public name: string,
      public files: File[],
      public ignore?: File) {
  }

  private static async extractRecursive(dirPath: string): Promise<void> {
    let foundZip = true;
    while (foundZip) {
      foundZip = false;
      const entries = await this.walkDir(dirPath);
      for (const entry of entries) {
        if (entry.toLowerCase().endsWith(".zip")) {
          foundZip = true;
          const extractDir = entry.replace(/\.zip$/i, "");
          try {
            await fs.mkdir(extractDir, { recursive: true });
            this.runCommand("unzip", ["-o", entry, "-d", extractDir]);
            this.runCommand("chmod", ["-R", "u+rwx", extractDir]);
          } catch {
            // skip corrupt zips
          }
          await fs.rm(entry, { force: true });
        }
      }
    }
  }

  private static async walkDir(dirPath: string): Promise<string[]> {
    const result: string[] = [];
    const dirs = [dirPath];
    let i = 0;
    while (i < dirs.length) {
      for (const entry of await fs.readdir(dirs[i], { withFileTypes: true })) {
        if (this.IGNORED_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dirs[i], entry.name);
        if (entry.isDirectory()) {
          dirs.push(fullPath);
        } else if (entry.isFile() && !entry.name.startsWith("._")) {
          result.push(fullPath);
        }
      }
      i += 1;
    }
    return result;
  }

  private static filterCorrectFiles(allFiles: string[]): string[] {
    const groups = new Map<string, string[]>();
    for (const filePath of allFiles) {
      const parentDir = path.dirname(filePath);
      if (!groups.has(parentDir)) {
        groups.set(parentDir, []);
      }
      groups.get(parentDir)!.push(filePath);
    }

    const result: string[] = [];
    for (const [, filesInDir] of groups) {
      const correctFiles = filesInDir.filter(f =>
        path.basename(f).toLowerCase().includes("correct")
      );
      if (correctFiles.length > 0) {
        result.push(...correctFiles);
      } else {
        result.push(...filesInDir);
      }
    }
    return result;
  }

  private static async collectStudentFiles(
    dirPath: string,
    studentId: string,
    fullName?: string,
    onlyCorrect?: boolean
  ): Promise<File[]> {
    let allFiles = await this.walkDir(dirPath);
    if (onlyCorrect) {
      allFiles = this.filterCorrectFiles(allFiles);
    }
    const files: File[] = [];
    const displayName = fullName || studentId;

    for (const filePath of allFiles) {
      const ext = path.extname(filePath).toLowerCase();
      if (IGNORED_EXTENSIONS.has(ext)) continue;
      if (!isCodeFile(filePath)) continue;

      const content = (await fs.readFile(filePath)).toString();
      const converted = convertFile(filePath, content);
      const finalPath = converted ? converted.path : filePath;
      const finalContent = converted ? converted.content : content;

      if (!finalContent.trim()) continue;

      const extra: ExtraInfo = {
        filename: path.basename(finalPath),
        fullName: displayName,
        id: studentId,
        status: "",
        submissionID: "",
        nameEN: "",
        nameNL: "",
        exerciseID: "",
        createdAt: new Date(),
        labels: "",
        ignored: "",
        studentId,
      };

      files.push(new File(finalPath, finalContent, extra));
    }

    return files;
  }

  private static async fromMultipleZips(
    zipPaths: string[],
    ignore?: string,
    onlyCorrect?: boolean
  ): Promise<Dataset> {
    const allFiles: File[] = [];
    const tmpDirs: string[] = [];

    try {
      for (const zipPath of zipPaths) {
        const tmpDir = await fs.mkdtemp(path.join(tmpdir(), "dolos-unzip-"));
        tmpDirs.push(tmpDir);

        this.runCommand("unzip", [zipPath, "-d", tmpDir]);
        this.runCommand("chmod", ["-R", "u+rwx", tmpDir]);

        // Get top-level entries to determine format
        const topEntries = await fs.readdir(tmpDir, { withFileTypes: true });
        const topDirs = topEntries.filter(e => e.isDirectory());
        const topZips = topEntries.filter(e => e.isFile() && e.name.toLowerCase().endsWith(".zip"));

        if (topZips.length > 0 && topDirs.length === 0) {
          // DOMjudge format: root has only .zip files, each = 1 student
          await this.extractRecursive(tmpDir);
          const studentDirs = await fs.readdir(tmpDir, { withFileTypes: true });
          for (const sd of studentDirs) {
            if (sd.isDirectory()) {
              const studentId = sd.name;
              const studentFiles = await this.collectStudentFiles(
                path.join(tmpDir, sd.name),
                studentId,
                undefined,
                onlyCorrect
              );
              allFiles.push(...studentFiles);
            }
          }
        } else {
          // LMS format: root has directories named studentID_NAME or similar
          // First extract any nested zips
          await this.extractRecursive(tmpDir);
          const studentDirs = await fs.readdir(tmpDir, { withFileTypes: true });
          for (const sd of studentDirs) {
            if (sd.isDirectory()) {
              const studentId = sd.name.split("_")[0] || sd.name;
              const studentFiles = await this.collectStudentFiles(
                path.join(tmpDir, sd.name),
                studentId,
                undefined,
                onlyCorrect
              );
              allFiles.push(...studentFiles);
            }
          }
        }
      }

      const nameCandidate = zipPaths.map(p => path.basename(p, ".zip")).join(" & ");
      const ignoredFile = ignore ? (await readPath(ignore)).ok() : undefined;
      return new Dataset(nameCandidate, allFiles, ignoredFile);
    } finally {
      for (const tmpDir of tmpDirs) {
        await fs.rm(tmpDir, { recursive: true }).catch(() => {});
      }
    }
  }

  private static async setIgnoredFile(resolvedFiles: File[], ignore?: string): Promise<File | undefined> {
    const ignoredFiles = resolvedFiles.filter(file => file.extra?.ignored === "true");
    if (ignoredFiles.length > 1) {
      throw new Error(
        "More than one file has the ignored field set to true. " +
        "Only one template/boilerplate code file is allowed at this moment."
      );
    }
    else if (ignore) {
      return (await readPath(ignore)).ok();
    }
    return ignoredFiles.length === 1 ? ignoredFiles[0] : undefined;
  }

  private static runCommand(
    command: string,
    args: string[]
  ): void {
    const result = spawn(command, args);
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0 && !(command === "unzip" && result.status === 1)) {
      throw new Error(
        `The ${command} command failed with exit status ${result.status}, stderr:\n${result.stderr}`
      );
    }
  }

  private static async fromZIP(
    zipPath: string,
    ignore?: string,
    onlyCorrect?: boolean
  ): Promise<Dataset> {
    const tmpDir = await fs.mkdtemp(path.join(tmpdir(), "dolos-unzip-"));
    try {
      this.runCommand("unzip", [zipPath, "-d", tmpDir]);
      this.runCommand("chmod", ["-R", "u+rwx", tmpDir]);

      const infoPath = path.join(tmpDir, "info.csv");
      if (await fs.access(infoPath, constants.R_OK).then(() => true).catch(() => false)) {
        const dataset = await Dataset.fromCSV(infoPath, ignore);
        if (dataset) {
          dataset.name = path.basename(zipPath, ".zip");
          return dataset;
        }
        else {
          throw new Error("Failed to process files");
        }
      } else {
        // Detect structure and extract student submissions
        const files = await this.extractStudentSubmissions(tmpDir, onlyCorrect);
        if (files.length < 2) {
          // Fallback: read all code files from directory
          const allFiles = await this.collectCodeFiles(tmpDir);
          const ignoredFile = await this.setIgnoredFile(allFiles, ignore);
          const nameCandidate = path.basename(zipPath, ".zip");
          return new Dataset(nameCandidate, allFiles, ignoredFile);
        }
        const ignoredFile = await this.setIgnoredFile(files, ignore);
        const nameCandidate = path.basename(zipPath, ".zip");
        return new Dataset(nameCandidate, files, ignoredFile);
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  }

  private static readonly IGNORED_DIRS = new Set(["__MACOSX", ".DS_Store"]);

  /**
   * Extract student ID from folder name.
   * Handles formats like:
   *   "2902669545_FLORENSIA LIM"  → "2902669545"
   *   "2902564636+-+EVAN VABRIZIO" → "2902564636"
   */
  private static extractStudentId(folderName: string): string {
    // Try "+-+" separator first (DOMjudge format)
    const plusIdx = folderName.indexOf("+-+");
    if (plusIdx > 0) return folderName.substring(0, plusIdx);
    // Fall back to "_" separator (LMS format)
    return folderName.split("_")[0] || folderName;
  }

  /**
   * Detect zip structure and extract student submissions.
   *
   * Structure A (flat):    class.zip → {studentId}.zip → code files
   * Structure B (LMS):     class.zip → {studentId}_{name}/ → submission.zip → code files
   * Structure C (DOMjudge): class.zip → wrapper/ → {studentId}+-+{name}/ → Problem X/ → code files
   *
   * Automatically unwraps a single wrapper directory and skips __MACOSX.
   */
  private static async extractStudentSubmissions(dirPath: string, onlyCorrect?: boolean): Promise<File[]> {
    // Unwrap single wrapper directory (e.g., class.zip → ClassName/ → students...)
    const dirToProcess = await this.unwrapSingleDir(dirPath);
    return this.processStudentEntries(dirToProcess, onlyCorrect);
  }

  /**
   * If dirPath contains exactly one real directory (ignoring __MACOSX etc.)
   * and no code files or zips, unwrap into that directory.
   */
  private static async unwrapSingleDir(dirPath: string): Promise<string> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const realEntries = entries.filter(e => !this.IGNORED_DIRS.has(e.name));
    const dirs = realEntries.filter(e => e.isDirectory());
    const zips = realEntries.filter(e => e.isFile() && e.name.toLowerCase().endsWith(".zip"));
    const codeFiles = realEntries.filter(e => e.isFile() && isCodeFile(e.name));

    if (dirs.length === 1 && zips.length === 0 && codeFiles.length === 0) {
      return path.join(dirPath, dirs[0].name);
    }
    return dirPath;
  }

  private static async processStudentEntries(dirPath: string, onlyCorrect?: boolean): Promise<File[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const allFiles: File[] = [];

    for (const entry of entries) {
      if (this.IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        // Structure A: top-level student zip
        const studentId = path.basename(entry.name, path.extname(entry.name));
        const studentDir = path.join(dirPath, `_student_${studentId}`);
        await fs.mkdir(studentDir, { recursive: true });
        try {
          this.runCommand("unzip", ["-o", fullPath, "-d", studentDir]);
          this.runCommand("chmod", ["-R", "u+rwx", studentDir]);
        } catch {
          continue;
        }
        await this.extractRecursive(studentDir);
        const studentFiles = await this.collectStudentFiles(studentDir, studentId, undefined, onlyCorrect);
        allFiles.push(...studentFiles);

      } else if (entry.isDirectory()) {
        const studentId = this.extractStudentId(entry.name);
        const fullName = entry.name.replace(/\+/g, " ").replace(/\s+-\s+/g, " - ");

        // Check for submission zips inside the folder
        const subEntries = await fs.readdir(fullPath, { withFileTypes: true });
        const subZips = subEntries.filter(
          e => e.isFile() && e.name.toLowerCase().endsWith(".zip")
        );

        if (subZips.length > 0) {
          for (const sz of subZips) {
            const szPath = path.join(fullPath, sz.name);
            const extractDir = szPath.replace(/\.zip$/i, "");
            await fs.mkdir(extractDir, { recursive: true });
            try {
              this.runCommand("unzip", ["-o", szPath, "-d", extractDir]);
              this.runCommand("chmod", ["-R", "u+rwx", extractDir]);
            } catch {
              continue;
            }
            await fs.rm(szPath, { force: true });
          }
        }

        await this.extractRecursive(fullPath);
        const studentFiles = await this.collectStudentFiles(fullPath, studentId, fullName, onlyCorrect);
        allFiles.push(...studentFiles);
      }
    }

    return allFiles;
  }

  /**
   * Collect all code files from a directory, applying conversion for .ipynb and .c files.
   * No student ID attached.
   */
  private static async collectCodeFiles(dirPath: string): Promise<File[]> {
    const allPaths = await this.walkDir(dirPath);
    const files: File[] = [];

    for (const filePath of allPaths) {
      const ext = path.extname(filePath).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) continue;

      const content = (await fs.readFile(filePath)).toString();
      const converted = convertFile(filePath, content);
      const finalPath = converted ? converted.path : filePath;
      const finalContent = converted ? converted.content : content;

      if (!finalContent.trim()) continue;
      files.push(new File(finalPath, finalContent));
    }

    return files;
  }


  private static async fromCSV(
    infoPath: string,
    ignore?: string
  ): Promise<Dataset> {
    const dirname = path.dirname(infoPath);
    try {
      const csv_files = csvParse((await fs.readFile(infoPath)).toString())
        .map((row:  DSVRowString) => ({
          filename: row.filename as string,
          fullName: row.full_name as string,
          id: row.id as string,
          status: row.status as string,
          submissionID: row.submission_id as string,
          nameEN: row.name_en as string,
          nameNL: row.name_nl as string,
          exerciseID: row.exercise_id as string,
          createdAt: new Date(row.created_at as string),
          labels: row.label as string || row.labels as string,
          ignored: row.ignored as string
        }))
        .map((row: ExtraInfo) => readPath(path.join(dirname, row.filename), row));
      const resolvedFiles = await Result.all(csv_files);
      const ignoredFile = await this.setIgnoredFile(resolvedFiles.ok(), ignore);
      const files = resolvedFiles.ok().filter(file => file.extra?.ignored !== "true");
      const nameCandidate = path.dirname(infoPath).split(path.sep).pop() || "undefined";
      return new Dataset(nameCandidate, files, ignoredFile);
    } catch {
      throw new Error("The given '.csv'-file could not be opened");
    }
  }


  public static async create(paths: string[], ignore?: string, onlyCorrect?: boolean): Promise<Dataset> {
    if (paths.length == 1) {
      const inputFile = paths[0];
      if (inputFile.toLowerCase().endsWith(".zip")) {
        return Dataset.fromZIP(inputFile, ignore, onlyCorrect);
      } else if (inputFile.toLowerCase().endsWith(".csv")) {
        return Dataset.fromCSV(inputFile, ignore);
      } else {
        throw new Error("You gave one input file, but it is not a CSV file or a ZIP archive.");
      }
    } else if (paths.every(p => p.toLowerCase().endsWith(".zip"))) {
      return Dataset.fromMultipleZips(paths, ignore, onlyCorrect);
    } else {
      const resolvedFiles = (await readFiles(paths)).ok();
      const resolvedIgnoredFile = await this.setIgnoredFile(resolvedFiles, ignore);
      const nameCandidate = path.basename(paths[0]) + " & " + path.basename(paths[1]);
      return new Dataset(nameCandidate, resolvedFiles, resolvedIgnoredFile);
    }
  }
}
