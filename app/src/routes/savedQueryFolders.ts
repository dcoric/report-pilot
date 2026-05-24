import type { ServerResponse } from "http";
import type { AuthedRequest } from "../lib/authGate";
import { json, readJsonBody } from "../lib/http";
import * as savedQueryFolderService from "../services/savedQueryFolderService";

function callerId(req: AuthedRequest): string | null {
  return (req.user && req.user.id) || null;
}

function writeResult(res: ServerResponse, result: { statusCode: number; body: unknown }): void {
  return json(res, result.statusCode, result.body);
}

async function handleCreateSavedQueryFolder(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req) as Record<string, unknown>;
  const result = await savedQueryFolderService.createFolder({
    ownerId: callerId(req),
    name: body.name,
    parentId: body.parent_id
  });
  return writeResult(res, result);
}

async function handleListSavedQueryFolders(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const result = await savedQueryFolderService.listFolders({
    ownerId: callerId(req)
  });
  return writeResult(res, result);
}

async function handleUpdateSavedQueryFolder(req: AuthedRequest, res: ServerResponse, folderId: string): Promise<void> {
  const body = await readJsonBody(req) as Record<string, unknown>;
  const result = await savedQueryFolderService.updateFolder(folderId, {
    ownerId: callerId(req),
    name: body.name,
    parentId: body.parent_id
  });
  return writeResult(res, result);
}

async function handleDeleteSavedQueryFolder(req: AuthedRequest, res: ServerResponse, folderId: string): Promise<void> {
  const result = await savedQueryFolderService.deleteFolder(folderId, {
    ownerId: callerId(req)
  });
  return writeResult(res, result);
}

async function handleMoveSavedQuery(req: AuthedRequest, res: ServerResponse, savedQueryId: string): Promise<void> {
  const body = await readJsonBody(req) as Record<string, unknown>;
  const result = await savedQueryFolderService.moveSavedQuery(savedQueryId, {
    ownerId: callerId(req),
    folderId: body.folder_id
  });
  return writeResult(res, result);
}

export {
  handleCreateSavedQueryFolder,
  handleListSavedQueryFolders,
  handleUpdateSavedQueryFolder,
  handleDeleteSavedQueryFolder,
  handleMoveSavedQuery
};
