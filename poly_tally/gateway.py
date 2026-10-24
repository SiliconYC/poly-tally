"""Token-free gateway transport; never consults a GitHub credential helper.

The only local secret is the independent gateway password. A gateway URL is an
HTTPS origin, never a URL containing credentials, a query, or a path prefix.
"""
import os
import re
import stat
from pathlib import Path
from urllib.parse import urlsplit


def _proxy_password_file(filename):
    # Only the explicitly configured NEW proxy password file is read. No PAT
    # filename search, legacy secret discovery, helper, or clipboard access.
    descriptor = None
    try:
        path = Path(filename)
        root = Path(__file__).resolve().parents[1]
        if not path.is_absolute() or path.resolve() != path or path.is_relative_to(root):
            raise ValueError()
        parent = path.parent.stat()
        if not stat.S_ISDIR(parent.st_mode) or stat.S_IMODE(parent.st_mode) != 0o700 or parent.st_uid != os.getuid():
            raise ValueError()
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid() or not 40 <= info.st_size <= 257:
            raise ValueError()
        value = os.read(descriptor, 258).decode('ascii').removesuffix('\n')
        return value
    except (OSError, ValueError, UnicodeError):
        raise ValueError('Proxy password file must be explicit, outside the repository, owner-only 0600 with a 0700 parent') from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def gateway_config(env=None):
    env = os.environ if env is None else env
    url, password = env.get('POLY_TALLY_GATEWAY_URL'), env.get('POLY_TALLY_GATEWAY_PASSWORD')
    filename = env.get('POLY_TALLY_GATEWAY_PASSWORD_FILE')
    if not url and not password and not filename:
        return None
    if any(key in env for key in ('POLY_TALLY_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN')):
        raise ValueError('Gateway mode forbids GitHub token environment variables')
    if filename:
        if password:
            raise ValueError('Choose one proxy password source, never both')
        password = _proxy_password_file(filename)
    try:
        parsed = urlsplit(url or '')
        port = parsed.port
    except (ValueError, TypeError):
        raise ValueError('Invalid gateway HTTPS origin') from None
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment or port not in (None, 443)
            or not password or re.match(r'(?i)^(?:gh[pousr]_|github_pat_)', password) or not 40 <= len(password) <= 256 or any(ord(c) < 33 or ord(c) > 126 for c in password)):
        raise ValueError('Gateway requires an HTTPS origin and a separate strong proxy password')
    return f'https://{parsed.hostname}', password


def api_url(address, env=None):
    config = gateway_config(env)
    if config is None:
        return address
    origin, _ = config
    parsed = urlsplit(address)
    if parsed.scheme == 'https' and parsed.netloc == 'api.github.com' and not parsed.fragment:
        return f'{origin}/api{parsed.path}' + (f'?{parsed.query}' if parsed.query else '')
    gateway = urlsplit(origin)
    if parsed.scheme == gateway.scheme and parsed.netloc == gateway.netloc and parsed.path.startswith('/api/') and not parsed.fragment:
        return address
    raise ValueError('Gateway API pagination must stay on the configured gateway or canonical GitHub API')


def git_url(address, env=None):
    config = gateway_config(env)
    if config is None:
        return address
    match = re.fullmatch(r'https://github\.com/(SiliconYC/([A-Za-z0-9_.-]{1,100}))\.git', address)
    if not match or match[2] in ('.', '..'):
        raise ValueError('Gateway Git requires a canonical authorized SiliconYC HTTPS repository')
    return f'{config[0]}/git/{match[1]}.git'


def git_environment(env=None):
    env = dict(os.environ if env is None else env)
    config = gateway_config(env)
    if config is None:
        return env
    origin, password = config
    env = {key: value for key, value in env.items() if not key.startswith(('GIT_CONFIG', 'GIT_TRACE', 'GIT_CURL_VERBOSE')) and key not in ('GIT_SSL_NO_VERIFY','GIT_ASKPASS','SSH_ASKPASS','GIT_PROXY_COMMAND')}
    env.update(GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_ALLOW_PROTOCOL='https')
    settings = [('credential.helper', ''), ('http.followRedirects', 'false'), ('http.proxy', ''),
                ('http.sslVerify', 'true'), ('http.extraheader', ''), (f'http.{origin}/.extraheader', f'Authorization: Bearer {password}')]
    env['GIT_CONFIG_COUNT'] = str(len(settings))
    for i, (key, value) in enumerate(settings):
        env[f'GIT_CONFIG_KEY_{i}'], env[f'GIT_CONFIG_VALUE_{i}'] = key, value
    return env
