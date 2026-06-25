import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const REQUIRED_MODULES = [
  'sherpa_onnx',
  'sounddevice',
  'soundfile',
  'numpy',
  'huggingface_hub',
  'pyautogui',
  'pynput',
];

const REQUIRED_PACKAGES = [
  'sherpa-onnx',
  'sounddevice',
  'soundfile',
  'numpy',
  'huggingface_hub',
  'pyautogui',
  'pynput',
  'moonshine-voice',
];

export function pythonScriptPath(name: string): string {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'scripts', name);
  }
  return path.join(__dirname, '..', 'python', name);
}

export function linuxVenvDir(): string {
  return path.join(app.getPath('userData'), 'python-venv');
}

function linuxVenvPython(): string {
  return path.join(linuxVenvDir(), 'bin', 'python3');
}

export function pythonExecutable(): string {
  if (process.env.OPENWHISPER_PYTHON) {
    return process.env.OPENWHISPER_PYTHON;
  }

  if (app?.isPackaged && process.platform === 'darwin') {
    const bundledPython = path.join(process.resourcesPath, 'python', 'bin', 'python3');
    if (fs.existsSync(bundledPython)) return bundledPython;
  }

  if (app?.isPackaged && process.platform === 'linux') {
    const venvPython = linuxVenvPython();
    if (fs.existsSync(venvPython)) return venvPython;
  }

  const devVenvPython = path.join(__dirname, '..', '.venv', 'bin', 'python3');
  if (!app?.isPackaged && fs.existsSync(devVenvPython)) {
    return devVenvPython;
  }

  return 'python3';
}

function runPython(args: string[], onProgress?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { env: process.env });
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      if (onProgress) {
        for (const line of text.split(/\r?\n/).filter(Boolean)) onProgress(line);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (onProgress) {
        for (const line of text.split(/\r?\n/).filter(Boolean)) onProgress(line);
      }
    });

    child.on('error', reject);
    child.on('exit', (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

export async function checkPythonRuntime(): Promise<{ ok: boolean; missing: string[]; python: string }> {
  const python = pythonExecutable();
  const script = `
import importlib.util, json
mods = ${JSON.stringify(REQUIRED_MODULES)}
missing = [m for m in mods if importlib.util.find_spec(m) is None]
print(json.dumps(missing))
`.trim();

  return new Promise((resolve) => {
    const child = spawn(python, ['-c', script]);
    let stdout = '';
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.on('error', () => resolve({ ok: false, missing: REQUIRED_MODULES, python }));
    child.on('exit', (code: number) => {
      if (code !== 0) {
        resolve({ ok: false, missing: REQUIRED_MODULES, python });
        return;
      }

      try {
        const missing = JSON.parse(stdout.trim());
        resolve({ ok: missing.length === 0, missing, python });
      } catch {
        resolve({ ok: false, missing: REQUIRED_MODULES, python });
      }
    });
  });
}

export async function installLinuxPythonRuntime(onProgress?: (line: string) => void): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('Python runtime setup is only supported on Linux.');
  }

  const venvDir = linuxVenvDir();
  const venvPython = linuxVenvPython();

  if (!fs.existsSync(venvPython)) {
    onProgress?.(`Creating Python environment at ${venvDir}`);
    await runPython(['python3', '-m', 'venv', venvDir], onProgress);
  }

  onProgress?.('Upgrading pip');
  await runPython([venvPython, '-m', 'pip', 'install', '--upgrade', 'pip'], onProgress);

  onProgress?.('Installing speech and keyboard packages');
  await runPython([
    venvPython,
    '-m',
    'pip',
    'install',
    '--upgrade',
    ...REQUIRED_PACKAGES,
  ], onProgress);
}
