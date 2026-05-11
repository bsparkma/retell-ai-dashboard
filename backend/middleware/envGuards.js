/**
 * Environment guards — block dangerous operations when the matching
 * env flag is set to the string "true". These are intended for dev
 * deployments that share external credentials with production.
 *
 * Set these in a dev backend `.env`:
 *   OPENDENTAL_WRITE_DISABLED=true
 *   RETELL_AGENT_PUBLISH_DISABLED=true
 *   MANGO_SYNC_DISABLED=true
 */

const isTrue = (v) => String(v ?? '').trim().toLowerCase() === 'true';

function isOdWriteDisabled() {
  return isTrue(process.env.OPENDENTAL_WRITE_DISABLED);
}

function isAgentPublishDisabled() {
  return isTrue(process.env.RETELL_AGENT_PUBLISH_DISABLED);
}

function isMangoSyncDisabled() {
  return isTrue(process.env.MANGO_SYNC_DISABLED);
}

function requireOdWriteEnabled(req, res, next) {
  if (isOdWriteDisabled()) {
    return res.status(403).json({
      success: false,
      error: 'Open Dental writes disabled in this environment',
      code: 'OD_WRITE_DISABLED',
    });
  }
  next();
}

function requireAgentPublishEnabled(req, res, next) {
  if (isAgentPublishDisabled()) {
    return res.status(403).json({
      success: false,
      error: 'Retell agent publishing disabled in this environment',
      code: 'AGENT_PUBLISH_DISABLED',
    });
  }
  next();
}

module.exports = {
  isOdWriteDisabled,
  isAgentPublishDisabled,
  isMangoSyncDisabled,
  requireOdWriteEnabled,
  requireAgentPublishEnabled,
};
