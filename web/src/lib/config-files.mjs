import path from 'node:path';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { WorkspaceError } from './career-workspace.mjs';
import { readWorkspaceFile, validateWorkspaceContent } from './workspace-files.mjs';
import { isMapping } from './portals-config.mjs';

// Only user-layer configuration files are exposed. The request supplies an ID,
// never a filesystem path. Overrides are resolved by the existing web helpers.
export const CONFIG_FILES = Object.freeze([
  { id: 'portals', name: 'portals.yml', description: 'Job sources, saved searches, and title and location filters.' },
  { id: 'profile', name: 'config/profile.yml', description: 'Candidate settings, target roles, preferences, and compensation.' },
  { id: 'jev-criteria', name: 'config/jev-criteria.yml', description: 'Criteria used to pre-screen job listings.' },
  { id: 'notion-map', name: 'config/notion-map.yml', description: 'Notion pages used when syncing career records.' },
  { id: 'plugins', name: 'config/plugins.yml', description: 'Optional integrations and their settings.' },
]);
export const MAX_CONFIG_BYTES = 1_000_000;

/** @typedef {{root:string,portalsPath:string,profilePath:string}} ConfigLocation */

/** @param {unknown} id */
function configInfo(id) {
  const info = CONFIG_FILES.find((item) => item.id === id);
  if (!info) throw new WorkspaceError('Unknown configuration file.', 'unknown_file', 404);
  return info;
}

/** @param {string} content */
export function configYamlError(content) {
  try {
    if (!isMapping(yaml.load(content))) return 'Use named YAML settings, not an empty document, list, or single value.';
    return null;
  } catch (error) {
    // Do not return js-yaml's message: it includes a snippet of the file.
    const line = Number.isInteger(error?.mark?.line) ? ` at line ${error.mark.line + 1}` : '';
    return `Invalid YAML${line}. Check indentation, quotes, and duplicate keys.`;
  }
}

/** @param {ConfigLocation} location @param {unknown} id */
export function readConfigFile(location, id) {
  const info = configInfo(id);
  const root = path.resolve(location.root);
  const file = info.id === 'portals' ? location.portalsPath
    : info.id === 'profile' ? location.profilePath : path.join(root, info.name);
  const relative = path.relative(root, file);
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  // An explicit override may live outside the data root. That configured parent
  // is the boundary; symlink files and non-regular files remain forbidden.
  const value = outside
    ? readWorkspaceFile(path.dirname(file), path.basename(file), MAX_CONFIG_BYTES)
    : readWorkspaceFile(root, relative.split(path.sep).join('/'), MAX_CONFIG_BYTES);
  const revision = createHash('sha256').update(value.file).update('\0')
    .update(value.exists ? 'present\0' : 'missing\0').update(value.content).digest('hex');
  return { ...info, path: value.file, content: value.content, exists: value.exists, revision,
    warning: value.exists ? configYamlError(value.content) : null };
}

/**
 * Preserve the exact edited text, including comments. Keep the revision check
 * and backup/write synchronous, matching the existing workspace editor.
 * @param {{location:ConfigLocation,request:{file:unknown,content:unknown,revision:unknown},write:(file:string,content:string)=>unknown}} options
 */
export function saveConfigFile({ location, request, write }) {
  if (typeof request.revision !== 'string' || !/^[a-f0-9]{64}$/.test(request.revision)) {
    throw new WorkspaceError('Load the file before saving.', 'invalid_revision');
  }
  const content = validateWorkspaceContent(request.content, MAX_CONFIG_BYTES);
  const validation = configYamlError(content);
  if (validation) throw new WorkspaceError(validation, 'invalid_yaml');
  const before = readConfigFile(location, request.file);
  if (before.revision !== request.revision) {
    throw new WorkspaceError('This file changed elsewhere. Your draft is still here. Copy it before reloading the file.', 'stale', 409);
  }
  const changed = !before.exists || content !== before.content;
  const backup = changed ? write(before.path, content) : null;
  return { ...readConfigFile(location, request.file), backedUp: Boolean(backup) };
}
