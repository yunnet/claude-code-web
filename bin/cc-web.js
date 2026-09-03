#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const open = require('open');
const crypto = require('crypto');
const { startServer } = require('../src/server');

const program = new Command();

program
  .name('cc-web')
  .description('Web-based interface for Claude Code CLI')
  .version(require('../package.json').version)
  .option('-p, --port <number>', 'port to run the server on', '32352')
  .option('--no-open', 'do not automatically open browser')
  .option('--auth <token>', 'authentication token (visible to other users via /proc — prefer --auth-file)')
  .option('--auth-file <path>', 'read the authentication token from a file (first line)')
  .option('--disable-auth', 'disable authentication (not recommended for production)')
  .option('--https', 'enable HTTPS (requires cert files)')
  .option('--cert <path>', 'path to SSL certificate file')
  .option('--key <path>', 'path to SSL private key file')
  .option('--dev', 'development mode with additional logging')
  .option('--claude-alias <name>', 'display alias for Claude (default: env CLAUDE_ALIAS or "Claude")')
  .option('--ngrok-auth-token <token>', 'ngrok auth token to open a public tunnel')
  .option('--ngrok-domain <domain>', 'ngrok reserved domain to use for the tunnel')
  .option('--plans-dir <paths>', 'comma-separated plan directories for /api/plan links; when set, only these dirs are served (overrides the default project .claude/plans auto-discovery). Env: CCW_PLANS_DIR')
  .parse();

const options = program.opts();

function generateRandomToken(length = 10) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function main() {
  try {
    const port = parseInt(options.port, 10);
    
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Error: Port must be a number between 1 and 65535');
      process.exit(1);
    }

    // Handle authentication logic
    let authToken = null;
    let noAuth = options.disableAuth === true;
    
    if (!noAuth) {
      // Where the token comes from, in order of how well it hides.
      //
      // `--auth` lands in /proc/<pid>/cmdline, which is mode 444 — readable by
      // every user on the machine. That is the reason the other two exist. It
      // still works, so nobody's start script breaks; it just says so.
      //
      // The env var is a real improvement rather than a cosmetic one:
      // /proc/<pid>/environ is mode 600, so it closes the cross-user read.
      // A file goes one further and keeps the token out of the process image
      // entirely.
      if (options.authFile) {
        try {
          const raw = fs.readFileSync(options.authFile, 'utf8');
          authToken = raw.split('\n')[0].trim();
        } catch (error) {
          console.error(`Error: cannot read --auth-file ${options.authFile}: ${error.message}`);
          process.exit(1);
        }
        if (!authToken) {
          console.error(`Error: --auth-file ${options.authFile} is empty`);
          process.exit(1);
        }
      } else if (process.env.CCWEB_AUTH) {
        authToken = process.env.CCWEB_AUTH;
      } else if (options.auth) {
        authToken = options.auth;
        console.warn(
          'Note: --auth puts the token in /proc/<pid>/cmdline, which other users on this\n' +
          '      machine can read. Use --auth-file or CCWEB_AUTH to avoid that.',
        );
      } else {
        // Unchanged: no token given still means one is generated, and auth
        // stays on. This default is load-bearing — do not "improve" it.
        authToken = generateRandomToken();
      }
    }

    const serverOptions = {
      port,
      auth: authToken,
      noAuth: noAuth,
      https: options.https,
      cert: options.cert,
      key: options.key,
      dev: options.dev,
      // UI alias for the assistant
      claudeAlias: options.claudeAlias || process.env.CLAUDE_ALIAS || 'Claude',
      // Explicit plan directories for /api/plan (comma-separated). Overrides the
      // default project .claude/plans auto-discovery when set.
      planDirs: (options.plansDir || process.env.CCW_PLANS_DIR || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => path.resolve(p)),
      folderMode: true // Always use folder mode
    };

    console.log('Starting Claude Code Web Interface...');
    console.log(`Port: ${port}`);
    console.log('Mode: Folder selection mode');
    console.log(`Alias: Claude → "${serverOptions.claudeAlias}"`);
    if (serverOptions.planDirs.length) {
      console.log(`Plan dirs (seed, additive to auto-discovery): ${serverOptions.planDirs.join(', ')}`);
    }
    
    // Display authentication status prominently
    if (noAuth) {
      console.log('\n⚠️  AUTHENTICATION DISABLED - Server is accessible without a token');
      console.log('   (Use without --disable-auth flag for security in production)');
    } else {
      console.log('\n🔐 AUTHENTICATION ENABLED');
      if (options.auth) {
        console.log('   Using provided authentication token');
      } else {
        console.log('   Generated random authentication token:');
        console.log(`   \x1b[1m\x1b[33m${authToken}\x1b[0m`);
        console.log('   \x1b[2mSave this token - you\'ll need it to access the interface\x1b[0m');
      }
    }

    const server = await startServer(serverOptions);

    // ngrok setup
    const hasNgrokToken = !!options.ngrokAuthToken;
    const hasNgrokDomain = !!options.ngrokDomain;

    if ((hasNgrokToken && !hasNgrokDomain) || (!hasNgrokToken && hasNgrokDomain)) {
      console.error('Error: Both --ngrok-auth-token and --ngrok-domain are required to enable ngrok tunneling');
      process.exit(1);
    }

    let ngrokListener = null;
    
    const protocol = options.https ? 'https' : 'http';
    const url = `${protocol}://localhost:${port}`;
    
    console.log(`\n🚀 Claude Code Web Interface is running at: ${url}`);

    if (!noAuth) {
      console.log('\n📋 Authentication Required:');
      if (options.auth) {
        console.log('   Use your provided authentication token to access the interface');
      } else {
        console.log(`   Enter this token when prompted: \x1b[1m\x1b[33m${authToken}\x1b[0m`);
      }
    }
    
    // Start ngrok tunnel if both flags provided
    let publicUrl = null;
    if (hasNgrokToken && hasNgrokDomain) {
      console.log('\n🌐 Starting ngrok tunnel...');
      try {
        const mod = await import('@ngrok/ngrok');
        const ngrok = mod.default || mod;

        if (typeof ngrok.authtoken === 'function') {
          try { await ngrok.authtoken(options.ngrokAuthToken); } catch (_) {}
        }

        ngrokListener = await ngrok.connect({
          addr: port,
          authtoken: options.ngrokAuthToken,
          domain: options.ngrokDomain
        });

        if (ngrokListener && typeof ngrokListener.url === 'function') {
          publicUrl = ngrokListener.url();
        }

        if (!publicUrl && ngrokListener && ngrokListener.url) {
          publicUrl = ngrokListener.url; // fallback in case API exposes property
        }

        if (publicUrl) {
          console.log(`\n🌍 ngrok tunnel established: ${publicUrl}`);
        } else {
          console.log('\n🌍 ngrok tunnel established');
        }

        if (options.open && publicUrl) {
          try { await open(publicUrl); } catch (error) {
            console.warn('Could not automatically open browser:', error.message);
          }
        }

      } catch (error) {
        console.error('Failed to start ngrok tunnel:', error.message);
      }
    } else if (options.open) {
      // Open local URL only when ngrok not used and auto-open enabled
      try {
        await open(url);
      } catch (error) {
        console.warn('Could not automatically open browser:', error.message);
      }
    }

    console.log('\nPress Ctrl+C to stop the server\n');

    const shutdown = async () => {
      console.log('\nShutting down server...');
      // Close ngrok tunnel first if active
      if (ngrokListener && typeof ngrokListener.close === 'function') {
        try { await ngrokListener.close(); } catch (_) {}
      }
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => { shutdown(); });
    process.on('SIGTERM', () => { shutdown(); });

  } catch (error) {
    console.error('Error starting server:', error.message);
    process.exit(1);
  }
}

main();
