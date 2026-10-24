import { Client as BaseClient, MemoryJournal } from '../collaboration/client.mjs';
import { Document } from './model.mjs';
export { Document, MemoryJournal };
export class Client extends BaseClient { static Document = Document; }
