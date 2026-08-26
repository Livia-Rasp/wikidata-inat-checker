// @ts-check
// Protection for every route that changes state. Registered once in the API scope so that future
// mutating routes — discovery, and any later editing — inherit it without anyone remembering.
//
// The API is unauthenticated (docs/threat-model.md), so nothing here identifies *who* is calling. What
// it does is establish that the call came from this app in this browser, or from a local tool, and
// not from a page on the internet that a browser was pointed at:
//
//   - A **Host allowlist**, because binding to 127.0.0.1 is not by itself a defence. DNS rebinding
//     lets a public page resolve its own hostname to 127.0.0.1 and reach a loopback server through
//     the victim's browser; the Host header is what still says `evil.example` when it does.
//   - **Fetch metadata**, the modern CSRF defence. `Sec-Fetch-Site` and `Origin` are forbidden
//     headers: the browser sets them and page script cannot forge them. Absent both, the caller is
//     not a browser at all (curl, a script) and CSRF does not apply — a browser always sends one on
//     a write.
//   - **A JSON content type**, because Fastify parses `text/plain` by default and a cross-origin
//     HTML form can send exactly that without a preflight.
import fp from 'fastify-plugin';

/** Hostnames a loopback deployment answers to. ALLOWED_HOSTS adds to this, it does not replace it. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** Methods that cannot change state, and so are never guarded. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Some routes are not just writes — they spend the operator's Wikimedia and iNaturalist API
 * reputation. Those are marked `config: { privileged: true }` and additionally require a **loopback
 * peer address**, which is unforgeable, unlike `Host`: `curl -H 'Host: localhost'` forges that from
 * anywhere, so the Host allowlist below stops DNS rebinding and nothing else.
 *
 * The point is the day the read view goes public: nobody but a local user should be able to make
 * this server go and hammer Wikidata under the operator's identity.
 * @param {string|undefined} addr
 */
function isLoopback(addr) {
    if (!addr) return false;
    const a = addr.replace(/^::ffff:/, '');
    return a === '::1' || a === '127.0.0.1' || a.startsWith('127.');
}

/** `example.com:8080` → `example.com`. IPv6 literals keep their brackets. */
function hostname(hostHeader) {
    if (!hostHeader) return '';
    const host = String(hostHeader).trim().toLowerCase();
    if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
    return host.split(':')[0];
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{allowedHosts?: string[]}} opts
 */
async function writeGuard(app, opts) {
    const extra = (opts.allowedHosts ?? String(process.env.ALLOWED_HOSTS ?? '').split(','))
        .map(h => h.trim().toLowerCase())
        .filter(Boolean);
    const allowed = new Set([...LOOPBACK_HOSTS, ...extra]);

    app.addHook('onRequest', async (req, reply) => {
        // Checked before the safe-method exit: a privileged route is privileged whatever the verb.
        // `privileged` is this app's own route-config extension; Fastify's own config type doesn't
        // know about it.
        const routeConfig = /** @type {{privileged?: boolean}|undefined} */ (req.routeOptions?.config);
        if (routeConfig?.privileged && !isLoopback(req.socket?.remoteAddress)) {
            return reject(req, reply, 'not_local',
                'This endpoint spends the operator\'s API budget and is available locally only.');
        }
        if (SAFE_METHODS.has(req.method)) return;

        const host = String(req.headers.host ?? '');
        if (!allowed.has(hostname(host))) {
            return reject(req, reply, 'host_not_allowed',
                `Host ${host || '(none)'} may not write here`);
        }

        const site = req.headers['sec-fetch-site'];
        if (site !== undefined) {
            // same-site is rejected along with cross-site: a sibling subdomain is still not us.
            if (site !== 'same-origin' && site !== 'none') {
                return reject(req, reply, 'cross_site', 'Cross-site writes are not accepted');
            }
        } else if (req.headers.origin !== undefined) {
            // Older browsers, and plain-http origins, which are not sent Sec-Fetch-Site.
            let originHost;
            try {
                originHost = new URL(String(req.headers.origin)).host.toLowerCase();
            } catch {
                return reject(req, reply, 'bad_origin', 'Unparseable Origin');
            }
            if (originHost !== host.trim().toLowerCase()) {
                return reject(req, reply, 'cross_origin', 'Origin does not match Host');
            }
        }
        // Neither header: not a browser, so not a CSRF vector. Allowed on purpose.

        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type && type !== 'application/json') {
            return reject(req, reply, 'bad_content_type', 'Writes must be application/json');
        }
    });
}

function reject(req, reply, reason, message) {
    req.log.warn({
        reason,
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        site: req.headers['sec-fetch-site'],
    }, 'write rejected');
    return reply.status(403).send({ statusCode: 403, error: 'Forbidden', reason, message });
}

// fastify-plugin so the hook applies to the whole scope this is registered in, rather than being
// encapsulated into a child that has no routes.
export default fp(writeGuard, { name: 'write-guard' });

export const LOOPBACK_ONLY = LOOPBACK_HOSTS;
