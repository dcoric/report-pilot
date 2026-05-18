const { json, readJsonBody } = require("../lib/http");
const savedQueryFolderService = require("../services/savedQueryFolderService");

function callerId(req) {
  return (req.user && req.user.id) || null;
}

function writeResult(res, result) {
  return json(res, result.statusCode, result.body);
}

async function handleCreateSavedQueryFolder(req, res) {
  const body = await readJsonBody(req);
  const result = await savedQueryFolderService.createFolder({
    ownerId: callerId(req),
    name: body.name,
    parentId: body.parent_id
  });
  return writeResult(res, result);
}

async function handleListSavedQueryFolders(req, res) {
  const result = await savedQueryFolderService.listFolders({
    ownerId: callerId(req)
  });
  return writeResult(res, result);
}

async function handleUpdateSavedQueryFolder(req, res, folderId) {
  const body = await readJsonBody(req);
  const result = await savedQueryFolderService.updateFolder(folderId, {
    ownerId: callerId(req),
    name: body.name,
    parentId: body.parent_id
  });
  return writeResult(res, result);
}

async function handleDeleteSavedQueryFolder(req, res, folderId) {
  const result = await savedQueryFolderService.deleteFolder(folderId, {
    ownerId: callerId(req)
  });
  return writeResult(res, result);
}

async function handleMoveSavedQuery(req, res, savedQueryId) {
  const body = await readJsonBody(req);
  const result = await savedQueryFolderService.moveSavedQuery(savedQueryId, {
    ownerId: callerId(req),
    folderId: body.folder_id
  });
  return writeResult(res, result);
}

module.exports = {
  handleCreateSavedQueryFolder,
  handleListSavedQueryFolders,
  handleUpdateSavedQueryFolder,
  handleDeleteSavedQueryFolder,
  handleMoveSavedQuery
};
