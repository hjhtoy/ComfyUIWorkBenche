// Legacy regression scripts inspect state through these bindings in test builds only.
import { startWorkbench } from '../src/workbench.js';
import { readBatchProject } from '../src/batch/project.js';
import { template } from '../src/comfy/config.js';
import {
  buildGraph,
  graphJobData,
  matchWorkflow,
} from '../src/comfy/workflow.js';
import { jobs, states, terminal } from '../src/jobs/state.js';
import { clearOutputCache, mediaKey, saveOutputs } from '../src/media/outputs.js';
import { fileData, writeLocal } from '../src/storage/browser.js';
import { historyKey, persist, sessionKey } from '../src/storage/jobs.js';
import { mentionChip } from '../src/ui/mentions.js';
import { serverAddress, serverKey } from '../src/ui/servers.js';
import { applyTheme, directory } from '../src/ui/settings.js';

const { composer, player, runner } = startWorkbench();
Object.assign(window, {
  snapshot: composer.snapshot,
  editorChanged: composer.editorChanged,
  finish: runner.finish,
  jobs,
  states,
  terminal,
  template,
  buildGraph,
  graphJobData,
  matchWorkflow,
  historyKey,
  sessionKey,
  serverKey,
  persist,
  fileData,
  writeLocal,
  clearOutputCache,
  mediaKey,
  saveOutputs,
  serverAddress,
  mentionChip,
  applyTheme,
  readBatchProject,
  player: player.player,
  editor: composer.editor,
});
Object.defineProperty(window, 'directory', { get: () => directory });
