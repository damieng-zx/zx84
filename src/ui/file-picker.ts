export interface OpenFileResult {
  name: string;
  data: Uint8Array;
}

interface PickerOptions {
  id: string;
  extensions: string[];
  multiple?: boolean;
}

interface ShowOpenFilePickerOptions {
  id?: string;
  multiple?: boolean;
  types?: { description: string; accept: Record<string, string[]> }[];
}
interface FilePickerHandle {
  getFile(): Promise<File>;
}
type ShowOpenFilePicker = (opts: ShowOpenFilePickerOptions) => Promise<FilePickerHandle[]>;

export async function openFile(opts: PickerOptions): Promise<OpenFileResult[] | null> {
  const picker = (window as Window & { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
  if (picker) {
    try {
      const handles = await picker({
        id: opts.id,
        multiple: opts.multiple ?? false,
        types: [{
          description: 'Files',
          accept: { '*/*': opts.extensions },
        }],
      });
      const results: OpenFileResult[] = [];
      for (const handle of handles) {
        const file: File = await handle.getFile();
        results.push({
          name: file.name,
          data: new Uint8Array(await file.arrayBuffer()),
        });
      }
      return results;
    } catch {
      return null;
    }
  }

  return new Promise<OpenFileResult[] | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = opts.multiple ?? false;
    input.accept = opts.extensions.join(',');
    input.style.display = 'none';
    document.body.appendChild(input);

    let resolved = false;
    function done(value: OpenFileResult[] | null) {
      if (resolved) return;
      resolved = true;
      document.body.removeChild(input);
      resolve(value);
    }

    input.addEventListener('change', async () => {
      try {
        const files = input.files;
        if (!files || files.length === 0) { done(null); return; }
        const results: OpenFileResult[] = [];
        for (let i = 0; i < files.length; i++) {
          results.push({
            name: files[i].name,
            data: new Uint8Array(await files[i].arrayBuffer()),
          });
        }
        done(results);
      } catch {
        done(null);
      }
    });

    input.addEventListener('cancel', () => done(null));
    setTimeout(() => done(null), 120_000);
    input.click();
  });
}
