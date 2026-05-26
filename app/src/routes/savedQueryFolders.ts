import {
  readJsonBody,
  writeServiceResult,
  type RouteHandler,
  type RouteHandlerWithId
} from "../lib/http";
import * as savedQueryFolderService from "../services/savedQueryFolderService";
import type { AuthedRequest } from "../lib/authGate";
import type {
  CreateSavedQueryFolderRequest,
  UpdateSavedQueryFolderRequest,
  MoveSavedQueryRequest
} from "../types";

function callerId(req: AuthedRequest): string | null {
  return (req.user && req.user.id) || null;
}

const handleCreateSavedQueryFolder: RouteHandler<CreateSavedQueryFolderRequest> = async (req, res) => {
  const body = await readJsonBody<Partial<CreateSavedQueryFolderRequest>>(req);
  const result = await savedQueryFolderService.createFolder({
    ownerId: callerId(req),
    name: body.name,
    parentId: body.parent_id
  });
  return writeServiceResult(res, result);
};

const handleListSavedQueryFolders: RouteHandler = async (req, res) => {
  const result = await savedQueryFolderService.listFolders({
    ownerId: callerId(req)
  });
  return writeServiceResult(res, result);
};

const handleUpdateSavedQueryFolder: RouteHandlerWithId<UpdateSavedQueryFolderRequest> = async (req, res, folderId) => {
  const body = await readJsonBody<Partial<UpdateSavedQueryFolderRequest>>(req);
  const result = await savedQueryFolderService.updateFolder(folderId, {
    ownerId: callerId(req),
    name: body.name,
    parentId: body.parent_id
  });
  return writeServiceResult(res, result);
};

const handleDeleteSavedQueryFolder: RouteHandlerWithId = async (req, res, folderId) => {
  const result = await savedQueryFolderService.deleteFolder(folderId, {
    ownerId: callerId(req)
  });
  return writeServiceResult(res, result);
};

const handleMoveSavedQuery: RouteHandlerWithId<MoveSavedQueryRequest> = async (req, res, savedQueryId) => {
  const body = await readJsonBody<Partial<MoveSavedQueryRequest>>(req);
  const result = await savedQueryFolderService.moveSavedQuery(savedQueryId, {
    ownerId: callerId(req),
    folderId: body.folder_id
  });
  return writeServiceResult(res, result);
};

export {
  handleCreateSavedQueryFolder,
  handleListSavedQueryFolders,
  handleUpdateSavedQueryFolder,
  handleDeleteSavedQueryFolder,
  handleMoveSavedQuery
};
