#!/usr/bin/env python3
"""Poly Tally read-only Git wrapper. Never invoke credential helper to inspect a real PAT."""
import datetime as dt
import json
import os
import pwd
import shutil
from pathlib import Path
import re
import resource
import shlex
import stat
import subprocess
import sys
import tempfile

# Fixed locations: root must verify storage before user enters a secret.
USER_HOME = Path(pwd.getpwuid(os.getuid()).pw_dir)
PAT_FILE = USER_HOME / '.local/share/poly-tally-private/github.pat'
CACHE_ROOT = USER_HOME / '.cache/poly-tally/native-git'
GIT = shutil.which('git') or '/usr/bin/git'
OWNER = 'SiliconYC'
EXPIRES_AT = None
DIAGNOSTICS = USER_HOME / '.local/state/poly-tally/helper-diagnostics.jsonl'
# Optional reviewed NONSECRET path configuration next to this installed script.
# The path is fixed; no CLI/environment arbitrary-secret-path input is accepted.
PATH_CONFIG = Path(__file__).resolve().parent / 'paths.local.json'
if PATH_CONFIG.exists():
    configured = json.loads(PATH_CONFIG.read_text())
    if not isinstance(configured, dict) or set(configured) - {'patFile','cacheRoot','diagnostics'}:
        raise ValueError('invalid local path configuration')
    for key, variable in [('patFile','PAT_FILE'),('cacheRoot','CACHE_ROOT'),('diagnostics','DIAGNOSTICS')]:
        if key in configured:
            value = configured[key]
            if not isinstance(value,str) or not Path(value).is_absolute():
                raise ValueError('local paths must be absolute')
            globals()[variable] = Path(value)


class CredentialError(ValueError):
    pass

def disable_core_dumps():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

def diagnostic(event, **flags):
    # All callers supply enums, booleans or fixed codes, never untrusted values.
    record = {'time': dt.datetime.now(dt.timezone.utc).isoformat(), 'pid': os.getpid(), 'event': event, **flags}
    try:
        fd = os.open(DIAGNOSTICS, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, (json.dumps(record) + '\n').encode())
        finally:
            os.close(fd)
    except Exception:
        pass

def repo_name(value):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', value) or value in ('.', '..') or value.endswith('.git'):
        raise ValueError('invalid repository')
    return value

def authorized(fields):
    path = fields.get('path', '')
    if path.endswith('.git'):
        path = path[:-4]
    parts = path.split('/')
    return (fields.get('protocol') == 'https' and fields.get('host') == 'github.com'
            and len(parts) == 2 and parts[0] == OWNER
            and bool(re.fullmatch(r'[A-Za-z0-9_.-]+', parts[1])) and parts[1] not in ('.', '..')
            and fields.get('username', 'x-access-token') == 'x-access-token')

def read_secret():
    expiry = EXPIRES_AT
    if not expiry:
        metadata = json.loads((PAT_FILE.parent / 'metadata.json').read_text())
        if metadata.get('status') != 'user_entered':
            raise CredentialError('INPUT_NOT_COMPLETED')
        expiry = metadata.get('expires_at')
    if not expiry or dt.datetime.now(dt.timezone.utc) >= dt.datetime.fromisoformat(expiry):
        raise CredentialError('NOT_CONFIGURED_OR_EXPIRED')
    parent = PAT_FILE.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) != 0o700:
        raise CredentialError('DIRECTORY_METADATA_REJECTED')
    fd = os.open(PAT_FILE, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise CredentialError('FILE_METADATA_REJECTED')
        value = os.read(fd, 4097).strip()
        if not value or len(value) > 4096 or not all(33 <= c <= 126 for c in value):
            raise CredentialError('CREDENTIAL_FORMAT_REJECTED')
        return value
    finally:
        os.close(fd)

def credential_helper(action, input_stream=None, output_stream=None):
    diagnostic('helper_called', action=action if action in ('get','store','erase') else 'invalid')
    if action in ('store', 'erase'):
        return 0
    if action != 'get':
        return 1
    inp = input_stream if input_stream is not None else sys.stdin.buffer
    out = output_stream if output_stream is not None else sys.stdout.buffer
    raw = inp.read(8193)
    if len(raw) > 8192:
        diagnostic('parse_rejected', code='INPUT_TOO_LARGE')
        return 1
    try:
        fields = {}
        for line in raw.decode('utf-8').splitlines():
            if not line:
                break
            key, value = line.split('=', 1)
            # Legitimate repeatable wwwauth[] / capability[] / state[] are ignored.
            if key not in ('protocol', 'host', 'path', 'username'):
                continue
            if key in fields:
                diagnostic('parse_rejected', code='DUPLICATE_CORE_FIELD')
                return 1
            fields[key] = value
        diagnostic('scope', protocol_ok=fields.get('protocol') == 'https', host_ok=fields.get('host') == 'github.com',
                   pathOwner_ok=fields.get('path','').split('/')[0] == OWNER,
                   username_ok=fields.get('username','x-access-token') == 'x-access-token', authorized=authorized(fields))
        if not authorized(fields):
            return 1
        try:
            secret = read_secret()
        except Exception as exc:
            diagnostic('secret_rejected', exception_class=type(exc).__name__,
                       code=str(exc) if isinstance(exc, CredentialError) else 'SECRET_READ_EXCEPTION')
            return 1
        out.write(b'username=x-access-token\npassword=' + secret + b'\n\n')
        out.flush()
        diagnostic('provided_to_git', success=True)
        return 0
    except Exception as exc:
        diagnostic('protocol_exception', exception_class=type(exc).__name__, code='PROTOCOL_EXCEPTION')
        return 1

def clean_environment(home):
    env = {'PATH':'/usr/local/bin:/usr/bin:/bin', 'HOME':home, 'XDG_CONFIG_HOME':home,
           'LANG':'C.UTF-8','LC_ALL':'C.UTF-8','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null',
           'GIT_TERMINAL_PROMPT':'0','GIT_ASKPASS':'/bin/false','SSH_ASKPASS':'/bin/false','GCM_INTERACTIVE':'Never'}
    # Preserve existing platform networking; do not print/persist values.
    for key in ('HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','https_proxy','http_proxy','all_proxy','no_proxy'):
        if key in os.environ:
            env[key] = os.environ[key]
    return env

def options():
    helper = '!' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(Path(__file__).resolve())) + ' --credential-helper'
    return ['-c','credential.helper=', '-c','credential.helper='+helper,
            '-c','credential.useHttpPath=true','-c','credential.username=x-access-token',
            '-c','http.followRedirects=false','-c','http.sslVerify=true','-c','http.extraHeader=',
            '-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-c','protocol.https.allow=always',
            '-c','maintenance.auto=false','-c','gc.auto=0','-c','fetch.recurseSubmodules=false']

def default_branch_from_refs(data):
    branches = [line[len('ref: '):-len('\tHEAD')] for line in data.decode().splitlines()
                if line.startswith('ref: refs/heads/') and line.endswith('\tHEAD')]
    if len(branches) != 1 or not re.fullmatch(r'refs/heads/[A-Za-z0-9_./-]+',branches[0]) or '..' in branches[0]:
        raise ValueError('default branch invalid or missing')
    return branches[0]

def remote_summary(repo, data):
    if not data.strip():
        return {'repository': OWNER+'/'+repo, 'defaultBranch': None, 'head': None}
    branch = default_branch_from_refs(data)
    heads = [line.split('\t')[0] for line in data.decode().splitlines() if line.endswith('\tHEAD') and not line.startswith('ref: ')]
    if len(heads) != 1 or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', heads[0]):
        raise ValueError('invalid remote HEAD')
    return {'repository': OWNER+'/'+repo, 'defaultBranch': branch[len('refs/heads/'):], 'head': heads[0]}


def validate_mirror(mirror, env):
    if mirror.is_symlink() or not mirror.is_dir() or (mirror/'config').is_symlink():
        raise ValueError('unsafe mirror')
    allowed = {'core.repositoryformatversion','core.filemode','core.bare','core.logallrefupdates',
               'remote.origin.url','remote.origin.fetch','remote.origin.mirror'}
    result = subprocess.run([GIT,'--git-dir='+str(mirror),'config','--local','--no-includes','--name-only','--list'],
                            env=env,capture_output=True,check=True)
    if any(key.lower() not in allowed for key in result.stdout.decode().splitlines()):
        raise ValueError('unreviewed mirror configuration')

def main(args):
    disable_core_dumps()
    if args[:1] == ['--credential-helper']:
        diagnostic('helper_main',argc_ok=len(args)==2)
        return credential_helper(args[1] if len(args)==2 else '')
    if len(args)!=2 or args[0] not in ('ls-remote','fetch'):
        print('Usage: readonly_git.py {ls-remote|fetch} REPOSITORY',file=sys.stderr)
        return 2
    try:
        operation,repo=args[0],repo_name(args[1])
        url='https://github.com/'+OWNER+'/'+repo+'.git'
        with tempfile.TemporaryDirectory(prefix='poly-git-home-') as home:
            env=clean_environment(home)
            refs=subprocess.run([GIT,*options(),'ls-remote','--symref',url],cwd=home,env=env,capture_output=True,check=True)
            summary=remote_summary(repo,refs.stdout)
            if operation=='ls-remote':
                print(json.dumps(summary));return 0
            CACHE_ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
            mirror=CACHE_ROOT/(repo+'.git')
            if not mirror.exists():
                subprocess.run([GIT,'init','--bare','--template=',str(mirror)],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            validate_mirror(mirror,env)
            if (mirror/'shallow').exists():
                raise ValueError('shallow mirror rejected')
            if summary['head'] is None:
                print(json.dumps({**summary,'path':str(mirror)}));return 0
            branch=default_branch_from_refs(refs.stdout)
            subprocess.run([GIT,'check-ref-format',branch],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            result=subprocess.run([GIT,*options(),'--git-dir='+str(mirror),'fetch','--no-recurse-submodules',
                                   '--no-auto-maintenance','--no-tags',url,'+'+branch+':'+branch],cwd=home,env=env).returncode
            if result==0:
                subprocess.run([GIT,'--git-dir='+str(mirror),'symbolic-ref','HEAD',branch],env=env,check=True)
                actual=subprocess.run([GIT,'--git-dir='+str(mirror),'rev-parse',branch],env=env,capture_output=True,check=True).stdout.decode().strip()
                summary['head']=actual
                receipt={'repository':OWNER+'/'+repo,'default_branch_ref':branch,
                         'observed_head_response':refs.stdout.decode().splitlines(),
                         'fetched_at':dt.datetime.now(dt.timezone.utc).isoformat(),'shallow':False}
                fd=os.open(CACHE_ROOT/(repo+'.fetch-receipt.json'),os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
                with os.fdopen(fd,'w') as output:
                    json.dump(receipt,output,indent=2)
                print(json.dumps({**summary,'path':str(mirror)}))
            return result
    except Exception:
        print('Read-only Git request failed validation or execution; no credential details logged.',file=sys.stderr)
        return 1

if __name__=='__main__':
    raise SystemExit(main(sys.argv[1:]))
