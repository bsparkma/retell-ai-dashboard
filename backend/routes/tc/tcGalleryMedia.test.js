'use strict';

/**
 * /api/tc/gallery + /api/tc/smile-sim + /api/tc/media — metadata CRUD against
 * blob keys, the FEATURE_DISABLED generate endpoint, and the media proxy's
 * ownership check (key must be a stored blob key of the requested office).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');
const mediaStore = require('../../services/tcMediaStore');

const GALLERY = {
  title: 'Crown case — upper left',
  category: 'Crowns',
  beforeBlobKey: 'tc/gallery/abc-before.jpg',
  afterBlobKey: 'tc/gallery/abc-after.jpg',
};

test('gallery metadata CRUD round-trip, office-scoped', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/gallery?office=roland', GALLERY);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const g = created.body.galleryCase;
    assert.equal(g.beforeBlobKey, GALLERY.beforeBlobKey);

    const missingKey = await api(baseUrl, 'POST', '/api/tc/gallery?office=roland', {
      title: 'No images',
    });
    assert.equal(missingKey.status, 400, 'blob keys are required');

    const cross = await api(baseUrl, 'GET', `/api/tc/gallery/${g.galleryId}?office=valley`);
    assert.equal(cross.status, 404);

    const del = await api(baseUrl, 'DELETE', `/api/tc/gallery/${g.galleryId}?office=roland`);
    assert.equal(del.status, 200);
    const list = await api(baseUrl, 'GET', '/api/tc/gallery?office=roland');
    assert.equal(list.body.gallery.length, 0);
  } finally {
    await close();
  }
});

test('smile-sim: generate is FEATURE_DISABLED; save links a gallery entry atomically', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const gen = await api(baseUrl, 'POST', '/api/tc/smile-sim/generate?office=roland', {});
    assert.equal(gen.status, 501);
    assert.equal(gen.body.code, 'FEATURE_DISABLED');

    const kase = await api(baseUrl, 'POST', '/api/tc/cases?office=roland', {
      patientName: 'Sim Patient',
      category: 'cosmetic',
      status: 'presented',
      urgency: 'elective',
    });
    const caseId = kase.body.case.caseId;

    const saved = await api(baseUrl, 'POST', '/api/tc/smile-sim?office=roland', {
      caseId,
      treatmentType: 'Veneers',
      originalBlobKey: 'tc/sim/xyz-original.jpg',
      resultBlobKey: 'tc/sim/xyz-result.png',
      saveToGallery: true,
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const sim = saved.body.simulation;
    assert.equal(sim.savedToGallery, true);
    assert.equal(sim.createdBy, 'tc@carein.ai');
    assert.ok(sim.galleryId, 'gallery entry must be linked');

    const galleryRow = db.table('tc_gallery_cases').find((r) => r.gallery_id === sim.galleryId);
    assert.ok(galleryRow, 'gallery row written in the same transaction');
    assert.equal(galleryRow.title, 'Smile Sim — Sim Patient — Veneers');
    assert.equal(galleryRow.category, 'Veneers');

    const badCase = await api(baseUrl, 'POST', '/api/tc/smile-sim?office=roland', {
      caseId: '00000000-0000-4000-8000-000000000000',
      treatmentType: 'Veneers',
      originalBlobKey: 'k1',
      resultBlobKey: 'k2',
    });
    assert.equal(badCase.status, 404, 'unknown case must 404, nothing written');
  } finally {
    await close();
  }
});

test('media proxy: unknown or cross-office keys 404; unconfigured store 503', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await api(baseUrl, 'POST', '/api/tc/gallery?office=roland', GALLERY);

    const unknown = await api(baseUrl, 'GET', '/api/tc/media?office=roland&key=tc/other/nope.jpg');
    assert.equal(unknown.status, 404, 'a key not stored in any row must 404');

    const crossOffice = await api(baseUrl, 'GET', `/api/tc/media?office=valley&key=${encodeURIComponent(GALLERY.beforeBlobKey)}`);
    assert.equal(crossOffice.status, 404, "another office's key must be unreachable");

    // Owned key, but no blob store configured in this environment → 503.
    const owned = await api(baseUrl, 'GET', `/api/tc/media?office=roland&key=${encodeURIComponent(GALLERY.beforeBlobKey)}`);
    assert.equal(owned.status, 503);
    assert.equal(owned.body.code, 'MEDIA_STORE_UNCONFIGURED');
  } finally {
    await close();
  }
});

test('media proxy streams an owned blob and audits the PHI read', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  const originalOpen = mediaStore.openBlob;
  process.env.TC_BLOB_ACCOUNT_URL = 'https://sttest.blob.core.windows.net';
  try {
    await api(baseUrl, 'POST', '/api/tc/gallery?office=roland', GALLERY);

    mediaStore.openBlob = async (key) => {
      assert.equal(key, GALLERY.beforeBlobKey);
      return {
        stream: Readable.from([Buffer.from('fake-jpeg-bytes')]),
        contentType: 'image/jpeg',
        contentLength: 15,
      };
    };

    const res = await fetch(
      `${baseUrl}/api/tc/media?office=roland&key=${encodeURIComponent(GALLERY.beforeBlobKey)}`
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(await res.text(), 'fake-jpeg-bytes');

    assert.ok(
      auditRows(db).some((r) => r.action === 'READ' && r.resource_type === 'tc_media'),
      'serving a clinical photo must write an audit row'
    );
  } finally {
    mediaStore.openBlob = originalOpen;
    delete process.env.TC_BLOB_ACCOUNT_URL;
    await close();
  }
});
