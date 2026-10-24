import os
from pathlib import Path
from unittest.mock import patch
import pytest
from poly_tally.gateway import gateway_config, api_url, git_url, git_environment
from poly_tally.credentials import 凭证_类
from poly_tally.github import GitHub发现器_类
from poly_tally.git import Git对象_类

ENV={'POLY_TALLY_GATEWAY_URL':'https://gateway.example','POLY_TALLY_GATEWAY_PASSWORD':'fixture-proxy-password-not-a-real-secret-123456789'}

def test_gateway_configuration_fails_closed_without_consulting_legacy_credentials():
    for value in ['http://gateway.example','https://user:password@gateway.example','https://gateway.example/path','https://gateway.example?secret=x']:
        with pytest.raises(ValueError): gateway_config({**ENV,'POLY_TALLY_GATEWAY_URL':value})
    for key in ['GH_TOKEN','GITHUB_TOKEN','POLY_TALLY_TOKEN']:
        with pytest.raises(ValueError): gateway_config({**ENV,key:'fake-forbidden'})
    with patch.dict(os.environ,ENV,clear=True),patch('subprocess.run',side_effect=AssertionError('must not read helper')):
        assert 凭证_类.api_读取(True) is None

def test_gateway_url_mapping_only_maps_fixed_canonical_hosts():
    assert api_url('https://api.github.com/repos/SiliconYC/poly-tally',ENV)=='https://gateway.example/api/repos/SiliconYC/poly-tally'
    assert api_url('https://gateway.example/api/user/repos?page=2',ENV)=='https://gateway.example/api/user/repos?page=2'
    for address in ['https://evil.test/foo','https://api.github.com@evil.test/foo','https://gateway.example/not-api']:
        with pytest.raises(ValueError):api_url(address,ENV)
    assert git_url('https://github.com/SiliconYC/poly-tally.git',ENV)=='https://gateway.example/git/SiliconYC/poly-tally.git'
    for address in ['https://github.com/other/repo.git','file:///tmp/repo','https://github.com/SiliconYC/../repo.git']:
        with pytest.raises(ValueError):git_url(address,ENV)

def test_git_environment_isolated_from_helpers_traces_global_configs_and_url_rewrites():
    e=git_environment({**ENV,'GIT_TRACE':'1','GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'url.https://evil/.insteadOf','GIT_CONFIG_VALUE_0':'https://gateway.example'})
    assert e['GIT_CONFIG_GLOBAL']=='/dev/null'
    assert e['GIT_CONFIG_NOSYSTEM']=='1'
    assert 'GIT_TRACE' not in e
    config={e[f'GIT_CONFIG_KEY_{i}']:e[f'GIT_CONFIG_VALUE_{i}'] for i in range(int(e['GIT_CONFIG_COUNT']))}
    assert config['credential.helper']==''
    assert config['http.followRedirects']=='false'
    assert config['http.https://gateway.example/.extraheader']=='Authorization: Bearer '+ENV['POLY_TALLY_GATEWAY_PASSWORD']
    assert not any(k.startswith('url.') for k in config)

def test_discovery_sends_proxy_password_only_to_gateway_and_never_follows_redirects():
    with patch.dict(os.environ,ENV,clear=True):
        discovery=GitHub发现器_类()
        assert discovery.已认证
        with patch.object(discovery.会话,'get') as get:
            get.return_value.status_code=200
            get.return_value.headers={}
            discovery._请求('https://api.github.com/users/SiliconYC')
            assert get.call_args.args[0]=='https://gateway.example/api/users/SiliconYC'
            assert get.call_args.kwargs['allow_redirects'] is False
        assert discovery.会话.headers['Authorization']=='Bearer '+ENV['POLY_TALLY_GATEWAY_PASSWORD']
        assert discovery.会话.trust_env is False

def test_git_fetch_rewrites_only_source_and_leaves_cache_logic_intact(tmp_path):
    with patch.dict(os.environ,ENV,clear=True):
        git=Git对象_类(tmp_path/'objects.git')
        with patch.object(git,'api_命令',side_effect=[b'',b'',b'false\n',b'a'*40+b'\n']) as command:
            assert git.api_更新('https://github.com/SiliconYC/poly-tally.git','dev')=='a'*40
            assert 'https://gateway.example/git/SiliconYC/poly-tally.git' in command.call_args_list[1].args
            assert '--no-tags' in command.call_args_list[1].args
            assert '--no-write-fetch-head' in command.call_args_list[1].args

def test_existing_bare_cache_cannot_redirect_gateway_credentials(tmp_path):
    import subprocess
    with patch.dict(os.environ,ENV,clear=True):
        git=Git对象_类(tmp_path/'objects.git')
        subprocess.run(['git','--git-dir',str(git.路径),'config','url.https://evil.test/.insteadOf','https://gateway.example/'],check=True)
        with patch.object(git,'api_命令',side_effect=AssertionError('network command must never run')):
            with pytest.raises(RuntimeError,match='configuration'):
                git.api_更新('https://github.com/SiliconYC/poly-tally.git','dev')

def test_proxy_password_file_is_explicit_private_and_never_a_legacy_pat_lookup(tmp_path):
    directory=tmp_path/'owner-only';directory.mkdir(mode=0o700)
    path=directory/'proxy-password';path.write_text(ENV['POLY_TALLY_GATEWAY_PASSWORD']+'\n');path.chmod(0o600)
    env={'POLY_TALLY_GATEWAY_URL':ENV['POLY_TALLY_GATEWAY_URL'],'POLY_TALLY_GATEWAY_PASSWORD_FILE':str(path)}
    assert gateway_config(env)==(ENV['POLY_TALLY_GATEWAY_URL'],ENV['POLY_TALLY_GATEWAY_PASSWORD'])
    with pytest.raises(ValueError):gateway_config({**env,'POLY_TALLY_GATEWAY_PASSWORD':'another-fake-password'})
    path.chmod(0o644)
    with pytest.raises(ValueError):gateway_config(env)
    path.chmod(0o600);directory.chmod(0o755)
    with pytest.raises(ValueError):gateway_config(env)


def test_canonical_https_port_does_not_break_gateway_pagination():
    env={**ENV,'POLY_TALLY_GATEWAY_URL':'https://gateway.example:443/'}
    assert gateway_config(env)[0]=='https://gateway.example'
    assert api_url('https://gateway.example/api/user/repos?page=2',env).startswith('https://gateway.example/api/')

def test_github_shaped_fake_token_is_not_accepted_as_proxy_password():
    for prefix in ('ghp_', 'github_pat_', 'gho_'):
        with pytest.raises(ValueError):
            gateway_config({**ENV,'POLY_TALLY_GATEWAY_PASSWORD':prefix+'FAKE_NOT_REAL_'*5})

def test_invalid_url_parser_does_not_reflect_untrusted_secret_like_input():
    for url in ('https://gateway:ghp_FAKE_SENTINEL', 'https://[ghp_FAKE_SENTINEL'):
        with pytest.raises(ValueError) as error:
            gateway_config({**ENV,'POLY_TALLY_GATEWAY_URL':url})
        assert 'ghp_FAKE_SENTINEL' not in str(error.value)


def test_gateway_git_cannot_inherit_other_credential_sources_or_disable_tls(tmp_path):
    incoming = {**ENV, 'HOME': str(tmp_path), 'XDG_CONFIG_HOME': str(tmp_path),
                'GIT_SSL_NO_VERIFY': '1', 'GIT_ASKPASS': '/fake/spy', 'SSH_ASKPASS': '/fake/spy',
                'NETRC': str(tmp_path / 'fake.netrc'), 'CURL_HOME': str(tmp_path),
                'GIT_SSL_CERT': '/fake/client.pem', 'GIT_SSL_KEY': '/fake/client.key'}
    isolated = git_environment(incoming)
    assert isolated['GIT_ASKPASS'] == '/bin/false'
    assert isolated['SSH_ASKPASS'] == '/bin/false'
    # /dev/null is a non-directory on the supported Linux runner: neither Git nor
    # libcurl can find .netrc/global credential files below it.
    assert isolated['HOME'] == isolated['XDG_CONFIG_HOME'] == '/dev/null'
    for key in ('GIT_SSL_NO_VERIFY', 'NETRC', 'CURL_HOME', 'GIT_SSL_CERT', 'GIT_SSL_KEY'):
        assert key not in isolated


def test_real_git_401_never_uses_fake_askpass_helper_or_netrc(tmp_path):
    import ssl
    import subprocess
    import threading
    from http.server import HTTPServer, BaseHTTPRequestHandler

    # No inherited process environment or real config/credential paths. Every
    # possible source below is an explicitly invented temporary fixture.
    safe = {'PATH': '/usr/bin:/bin', 'HOME': str(tmp_path), 'XDG_CONFIG_HOME': str(tmp_path),
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}
    marker = tmp_path / 'spy-called'
    spy = tmp_path / 'fake-credential-spy'
    spy.write_text(f'#!/bin/sh\nprintf called >> "{marker}"\nexit 1\n')
    spy.chmod(0o700)
    netrc = tmp_path / '.netrc'
    netrc.write_text('machine localhost login fake-netrc-user password fake-netrc-password\n')
    netrc.chmod(0o600)
    cert, key = tmp_path / 'fixture.crt', tmp_path / 'fixture.key'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
                    '-keyout', str(key), '-out', str(cert)], env=safe, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    requests, basic_seen = [], []
    class Unauthorized(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(True)
            basic_seen.append((self.headers.get('Authorization') or '').startswith('Basic '))
            self.send_response(401)
            self.send_header('WWW-Authenticate', 'Basic realm="fake-only"')
            self.send_header('Content-Length', '0')
            self.end_headers()
        def log_message(self, *_):
            pass
    server = HTTPServer(('127.0.0.1', 0), Unauthorized)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        repo = tmp_path / 'fixture.git'
        subprocess.run(['git', 'init', '--bare', str(repo)], env=safe, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for name, value in [('core.askPass', str(spy)), ('credential.helper', f'!{spy}'), ('http.sslVerify', 'false')]:
            subprocess.run(['git', '--git-dir', str(repo), 'config', name, value], env=safe, check=True)
        isolated = git_environment({**safe, **ENV, 'GIT_ASKPASS': str(spy), 'SSH_ASKPASS': str(spy),
                                    'GIT_SSL_NO_VERIFY': '1', 'NETRC': str(netrc)})
        effective = subprocess.run(['git', '--git-dir', str(repo), 'config', '--bool', '--get', 'http.sslVerify'],
                                   env=isolated, check=True, capture_output=True)
        assert effective.stdout == b'true\n'
        result = subprocess.run(['git', '--git-dir', str(repo), '-c', f'http.sslCAInfo={cert}', 'ls-remote',
                                 f'https://localhost:{server.server_port}/fixture.git'], env=isolated,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        assert result.returncode != 0
        assert requests, 'trusted local HTTPS fixture must actually return 401'
        assert not marker.exists(), 'no AskPass/helper may run after authentication failure'
        assert not any(basic_seen), 'no fake .netrc credential may be sent'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
