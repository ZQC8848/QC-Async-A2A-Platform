// Entry point. Environment:
//   PORT          default 8080
//   ADMIN_TOKEN   required, at least 32 characters (Secret Manager on Cloud Run)
//   STORE         firestore (default) | memory (local experiments; data is lost on exit)
//   GCP_PROJECT   Firestore project id (required for STORE=firestore)
import http from 'node:http';
import { createApp } from './app.js';
import { FirestoreStore, MemoryStore } from './store.js';

const store = process.env.STORE === 'memory' ? new MemoryStore() : new FirestoreStore({ project: process.env.GCP_PROJECT });
const app = createApp(store, { adminToken: process.env.ADMIN_TOKEN });
const port = Number(process.env.PORT || 8080);
http.createServer(app).listen(port, () => console.log(`hub listening on :${port} (store: ${process.env.STORE || 'firestore'})`));
