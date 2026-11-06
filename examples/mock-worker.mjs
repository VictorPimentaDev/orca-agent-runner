// Transparent fixture: demonstrates the protocol, does not implement the SPEC.
import {writeFile} from 'node:fs/promises';
if (!process.env.OAR_RESULT_PATH || !process.env.OAR_TASK) throw new Error('Run this fixture through oar');
await writeFile(process.env.OAR_RESULT_PATH, `# Mock worker: ${process.env.OAR_TASK}\n\nProtocol demo only. No implementation was performed.\nFIM\n`, {flag: 'wx'});
