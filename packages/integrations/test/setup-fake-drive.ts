import { startFakeDriveServer, type FakeDriveServer } from './fake-drive.js';

let fakeServer: FakeDriveServer | null = null;

if (!process.env.GOOGLE_DRIVE_API_BASE_URL) {
  fakeServer = await startFakeDriveServer();
  process.env.GOOGLE_DRIVE_API_BASE_URL = fakeServer.url;
  process.env.GOOGLE_DRIVE_UPLOAD_BASE_URL = fakeServer.url;
  process.env.GOOGLE_SHEETS_API_BASE_URL = fakeServer.url;
  process.env.GOOGLE_OAUTH_TOKEN = ['test', 'local', 'token'].join('_');
}
