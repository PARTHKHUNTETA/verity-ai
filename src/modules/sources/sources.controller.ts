import type { RequestHandler } from "express";
import { getAuth } from "../../middleware/authenticate.js";
import { ValidationError } from "../../shared/errors.js";
import type { CreateCollectionInput, SearchInput } from "./sources.schema.js";
import type { SourcesService } from "./sources.service.js";

type CollectionParams = { collectionId: string };

export function createSourcesController(service: SourcesService) {
  const listCollections: RequestHandler = async (req, res) => {
    res.json({ collections: await service.listCollections(getAuth(req)) });
  };

  const createCollection: RequestHandler = async (req, res) => {
    res
      .status(201)
      .json(await service.createCollection(getAuth(req), req.body as CreateCollectionInput));
  };

  const getCollection: RequestHandler<CollectionParams> = async (req, res) => {
    res.json(await service.getCollection(getAuth(req), req.params.collectionId));
  };

  const deleteCollection: RequestHandler<CollectionParams> = async (req, res) => {
    await service.deleteCollection(getAuth(req), req.params.collectionId);
    res.status(204).end();
  };

  const upload: RequestHandler<CollectionParams> = async (req, res) => {
    if (!req.file) throw new ValidationError('Attach a file in the "file" field');
    const result = await service.upload(getAuth(req), req.params.collectionId, {
      // Browsers send UTF-8 names, but multer decodes them as latin1.
      originalName: Buffer.from(req.file.originalname, "latin1").toString("utf8"),
      buffer: req.file.buffer,
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  };

  const removeSource: RequestHandler<CollectionParams & { sourceId: string }> = async (
    req,
    res,
  ) => {
    await service.removeSource(getAuth(req), req.params.collectionId, req.params.sourceId);
    res.status(204).end();
  };

  const getSource: RequestHandler<{ sourceId: string }> = async (req, res) => {
    res.json(await service.getSource(getAuth(req), req.params.sourceId));
  };

  const listChunks: RequestHandler<{ sourceId: string }> = async (req, res) => {
    const page = req.query as unknown as { offset: number; limit: number };
    res.json({ chunks: await service.listChunks(getAuth(req), req.params.sourceId, page) });
  };

  const search: RequestHandler = async (req, res) => {
    res.json({ hits: await service.search(getAuth(req), req.body as SearchInput) });
  };

  return {
    listCollections,
    createCollection,
    getCollection,
    deleteCollection,
    upload,
    removeSource,
    getSource,
    listChunks,
    search,
  };
}
