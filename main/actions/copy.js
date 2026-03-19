import { clipboard } from 'electron';

export async function executeCopyAction(selectedText) {
  clipboard.writeText(selectedText);
}

