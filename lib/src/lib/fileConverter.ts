export interface ConvertedFile {
  path: string;
  content: string;
}

export function convertFile(filePath: string, content: string): ConvertedFile | null {
  if (filePath.endsWith(".c")) {
    return { path: filePath.replace(/\.c$/, ".cpp"), content };
  }
  if (filePath.endsWith(".ipynb")) {
    return convertNotebook(filePath, content);
  }
  return null;
}

function convertNotebook(filePath: string, content: string): ConvertedFile {
  try {
    const notebook = JSON.parse(content);
    const code = (notebook.cells || [])
      .filter((c: { cell_type: string }) => c.cell_type === "code")
      .map((c: { source: string | string[] }) =>
        Array.isArray(c.source) ? c.source.join("") : c.source
      )
      .join("\n\n");
    return { path: filePath.replace(/\.ipynb$/, ".py"), content: code };
  } catch {
    return { path: filePath.replace(/\.ipynb$/, ".py"), content: "" };
  }
}
