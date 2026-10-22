/**
 * Where a checkout keeps its GitHub Actions files. It lives outside
 * src/skills because the folder's name holds a word the skills copy never
 * uses (phase 2 design rule 6, P22): copy calls it "this repo's GitHub
 * Actions folder", never by its path.
 */
import { join } from 'node:path';

export const actionsFolder = (top: string): string => join(top, '.github', 'workflows');
