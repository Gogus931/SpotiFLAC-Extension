'use strict';

// Cases for the download path of sources/qobuz-web: the stream-resolution
// allowance, cancellation, transfer fallback and error typing.
//
// The same cases run under two runners, so nothing here may require node or a
// DOM. tests/qobuz_download_budget.test.cjs drives them with node:test, and the
// local Chromium harness used while developing this change drives them with the
// same `load` contract: load(overrides) -> { api, state }.
//
// `api` exposes the extension's own functions. In node that is the whole vm
// context; in the browser it is the same set, returned explicitly by the loader.

function expect(condition, message) {
  if (!condition) throw new Error(message || 'expectation failed');
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'value mismatch') +
      ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

// A provider that answers with a retryable failure and asks the client to come
// back later. The delay is the server's, never ours to shorten.
function retryableFailure(statusCode, retryAfterSeconds) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds)
    },
    body: JSON.stringify({ error: 'PROVIDER_UNAVAILABLE' }),
    retryable: true,
    retryMode: 'new_ticket'
  };
}

function downloadResponse(url) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ download_url: url, bit_depth: 24, sampling_rate: 96 })
  };
}

function ticketResponse(ticketID) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket_id: ticketID })
  };
}

function notFoundResponse() {
  return {
    statusCode: 404,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'track not found' })
  };
}

var PREPARED_OPTIONS = {
  preparedContext: {
    host_track: {
      name: 'Signal',
      artists: 'Artist',
      album_name: 'Record',
      duration_ms: 180000
    }
  }
};

function createHost(overrides) {
  overrides = overrides || {};

  var state = {
    sleeps: [],
    warnings: [],
    ticketCalls: 0,
    providerCalls: 0,
    cancelled: false,
    remainingMs: 60000,
    ticketID: 'fixture-ticket',
    responder: null
  };

  function signedFetch(method, path, body, headers) {
    if (String(path) === '/tickets') {
      state.ticketCalls++;
      return ticketResponse(state.ticketID);
    }
    state.providerCalls++;
    if (state.responder) return state.responder(state.providerCalls, path, body, headers);
    return downloadResponse('https://audio.example.test/track.flac');
  }

  var globals = {
    registerExtension: function (api) {
      state.api = api;
    },
    log: {
      info: function () {},
      debug: function () {},
      warn: function (message) {
        state.warnings.push(String(message));
      },
      error: function () {}
    },
    utils: {
      isDownloadCancelled: function () {
        return state.cancelled;
      },
      getResolutionRemainingMs: function () {
        return state.remainingMs;
      },
      sleep: function (ms) {
        state.sleeps.push(Number(ms));
        return true;
      },
      sha256: function (input) {
        return 'fixture-sha256:' + String(input);
      }
    },
    session: { signedFetch: signedFetch },
    file: {
      download: function (url, outputPath) {
        state.transfers = state.transfers || [];
        state.transfers.push(String(url));
        return { success: true, path: outputPath };
      },
      delete: function () {}
    },
    gobackend: {},
    http: {
      get: function () {
        throw new Error('http.get is not mocked for this case');
      },
      post: function () {
        throw new Error('http.post is not mocked for this case');
      }
    }
  };

  var globalKeys = Object.keys(overrides.globals || {});
  for (var i = 0; i < globalKeys.length; i++) {
    globals[globalKeys[i]] = overrides.globals[globalKeys[i]];
  }

  var stateKeys = Object.keys(overrides.state || {});
  for (var j = 0; j < stateKeys.length; j++) {
    state[stateKeys[j]] = overrides.state[stateKeys[j]];
  }

  return { globals: globals, state: state };
}

var CASES = [
  {
    name: 'a retry delay beyond the remaining allowance is a timeout, not a wait',
    run: function (load) {
      var tooLate = load({
        state: {
          remainingMs: 5000,
          responder: function () {
            return retryableFailure(503, 30);
          }
        }
      });

      var thrown = null;
      try {
        tooLate.api.resolveDownloadInfo('1', 'HI_RES_LOSSLESS');
      } catch (error) {
        thrown = error;
      }

      expect(thrown, 'a delay that cannot fit the allowance must not be waited out');
      expectEqual(thrown.errorType, 'timeout', 'the failure type must survive to the host');
      expect(/retry timeout/.test(String(thrown.message)), 'the message must state a timeout: ' + thrown.message);
      expectEqual(tooLate.state.sleeps.length, 0, 'no sleep may start when the sleep cannot fit');
      expectEqual(tooLate.state.providerCalls, 1, 'the failed request itself still happened');

      var inTime = load({
        state: {
          remainingMs: 60000,
          responder: function () {
            return retryableFailure(503, 30);
          }
        }
      });
      try {
        inTime.api.resolveDownloadInfo('1', 'HI_RES_LOSSLESS');
      } catch (error) {
        // The sweep still fails; only the waiting behaviour is under test.
      }
      expect(inTime.state.sleeps.length >= 1, 'the same delay is waited out when it fits');
      expect(inTime.state.sleeps[0] >= 30000,
        'the server delay is honoured as given and never shortened: ' + inTime.state.sleeps[0]);
      expect(inTime.state.providerCalls > tooLate.state.providerCalls,
        'the fitting allowance buys extra attempts: ' + inTime.state.providerCalls +
        ' vs ' + tooLate.state.providerCalls);
    }
  },
  {
    name: 'cancellation before the sweep sends no request and reports cancelled',
    run: function (load) {
      var host = load({ state: { cancelled: true } });
      var result = host.api.download('1', 'HI_RES_LOSSLESS', '/music/song.flac', null, PREPARED_OPTIONS);

      expectEqual(result.success, false, 'a cancelled download is not a success');
      expectEqual(result.error_type, 'cancelled', 'expected a cancelled type');
      expectEqual(host.state.providerCalls, 0, 'no provider request may start after cancellation');
    }
  },
  {
    name: 'cancellation between candidates stops the sweep instead of continuing it',
    run: function (load) {
      var host = load({
        state: {
          responder: function () {
            host.state.cancelled = true;
            return notFoundResponse();
          }
        }
      });

      var thrown = null;
      try {
        host.api.resolveDownloadInfo('1', 'HI_RES_LOSSLESS');
      } catch (error) {
        thrown = error;
      }

      expect(thrown, 'a cancellation must end the sweep');
      expectEqual(thrown.errorType, 'cancelled', 'the cancellation must stay a cancellation');
      expectEqual(host.state.providerCalls, 1, 'the next candidate must not be requested');
    }
  },
  {
    name: 'an unmeasurable duration is not reported as verified',
    run: function (load) {
      var host = load({});

      expectEqual(host.api.validateDownloadedDuration(180000, 0).verified, false,
        'an unmeasurable duration must not claim verification');
      expectEqual(host.api.validateDownloadedDuration(180000, 0).valid, true,
        'an unmeasurable duration is not a mismatch either');
      expectEqual(host.api.validateDownloadedDuration(180000, 180).verified, true,
        'a measured match is verified');
      expectEqual(host.api.validateDownloadedDuration(180000, 30).verified, true,
        'a measured mismatch is verified');
    }
  },
  {
    name: 'a download with an unmeasurable duration says so in the log',
    run: function (load) {
      var host = load({
        state: {
          responder: function () {
            return downloadResponse('https://audio.example.test/full-album-cut.flac');
          }
        }
      });

      var result = host.api.download('1', 'HI_RES_LOSSLESS', '/music/song.flac', null, PREPARED_OPTIONS);

      expectEqual(result.success, true, 'the transfer itself succeeded, so the result stays a success');
      var mentioned = host.state.warnings.some(function (message) {
        return message.indexOf('could not be verified') >= 0;
      });
      expect(mentioned, 'the unverified duration must be stated, warnings: ' +
        JSON.stringify(host.state.warnings));
    }
  },
  {
    name: 'a failed transfer falls through to the next candidate',
    run: function (load) {
      var transfers = [];
      var host = load({
        globals: {
          file: {
            download: function (url, outputPath) {
              transfers.push(String(url));
              if (transfers.length === 1) return { success: false, error: 'connection reset' };
              return { success: true, path: outputPath };
            },
            delete: function () {}
          }
        },
        state: {
          responder: function (callNumber) {
            return downloadResponse('https://audio.example.test/candidate-' + callNumber + '.flac');
          }
        }
      });

      var result = host.api.download('1', 'HI_RES_LOSSLESS', '/music/song.flac', null, PREPARED_OPTIONS);

      expectEqual(result.success, true, 'the next candidate must be allowed to finish the download');
      expectEqual(transfers.length, 2, 'expected two transfer attempts');
      expect(transfers[0] !== transfers[1], 'the second attempt must use the next candidate URL');
      var logged = host.state.warnings.some(function (message) {
        return message.indexOf('Stream transfer failed') >= 0;
      });
      expect(logged, 'the abandoned candidate must be visible in the log');
    }
  },
  {
    name: 'attempts are bounded for the whole download, not per candidate',
    run: function (load) {
      var host = load({
        state: {
          remainingMs: 60000,
          responder: function () {
            return retryableFailure(503, 0);
          }
        }
      });

      var thrown = null;
      try {
        host.api.resolveDownloadInfo('1', 'HI_RES_LOSSLESS');
      } catch (error) {
        thrown = error;
      }

      expect(thrown, 'a provider that never succeeds must fail the sweep');
      expect(host.state.providerCalls <= 5,
        'provider attempts are bounded per download, saw ' + host.state.providerCalls);
      expect(host.state.sleeps.length >= 1, 'retryable failures still wait before retrying');
      expect(host.state.providerCalls + 1 >= host.state.sleeps.length,
        'every wait belongs to a real attempt');
    }
  },
  {
    name: 'an allowance below the minimum step fails before any request',
    run: function (load) {
      var host = load({ state: { remainingMs: 10 } });
      var result = host.api.download('1', 'HI_RES_LOSSLESS', '/music/song.flac', null, PREPARED_OPTIONS);

      expectEqual(result.success, false, 'nothing can be resolved without allowance');
      expectEqual(result.error_type, 'timeout', 'an exhausted allowance is a timeout');
      expectEqual(host.state.providerCalls, 0, 'no request may start below the minimum step');
    }
  },
  {
    name: 'error typing keeps cancellation, timeout and verification apart',
    run: function (load) {
      var host = load({});

      expectEqual(host.api.classifyDownloadError(host.api.cancelledDownloadError()), 'cancelled',
        'a typed cancellation must survive');
      expectEqual(host.api.classifyDownloadError(host.api.resolutionTimeoutError('resolution timeout: out of allowance')),
        'timeout', 'a typed timeout must survive');
      expectEqual(host.api.classifyDownloadError(new Error('download cancelled')), 'cancelled',
        'a message-only cancellation must not become a runtime error');
      expectEqual(host.api.classifyDownloadError(new Error('VERIFY_REQUIRED')), 'verification_required',
        'a challenge keeps its own type');
      expectEqual(host.api.classifyDownloadError(new Error('boom')), 'runtime_error',
        'an unclassified failure stays a runtime error');
    }
  }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CASES: CASES, createHost: createHost };
}
