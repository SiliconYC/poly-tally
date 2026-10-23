"""All credentials are FAKE and isolated. Never calls the real credential file."""
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('h',HERE/'readonly_git.py');h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
RAW=b'protocol=https\nhost=github.com\npath=SiliconYC/vitro_union_lab.git\n\n'
class Tests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='fake-only-',dir=HERE);self.root=Path(self.temp.name);self.file=self.root/'fake.pat'
  self.fake=b'FAKE_TEST_NOT_A_GITHUB_TOKEN';self.file.write_bytes(self.fake);self.file.chmod(0o600)
  self.old=h.PAT_FILE,h.EXPIRES_AT,h.DIAGNOSTICS
  h.PAT_FILE=self.file;h.EXPIRES_AT=(dt.datetime.now(dt.timezone.utc)+dt.timedelta(days=1)).isoformat();h.DIAGNOSTICS=self.root/'diagnostics.jsonl'
 def tearDown(self):h.PAT_FILE,h.EXPIRES_AT,h.DIAGNOSTICS=self.old;self.temp.cleanup()
 def invoke(self,action='get',raw=RAW):
  out=io.BytesIO();rc=h.credential_helper(action,io.BytesIO(raw),out);return rc,out.getvalue()
 def test_valid_fake_pipe(self):
  rc,out=self.invoke();self.assertEqual(rc,0);self.assertTrue(out.endswith(self.fake+b'\n\n'))
 def test_scope_denials_do_not_read_file(self):
  for raw in [RAW.replace(b'https',b'http'),RAW.replace(b'github.com',b'github.com.evil'),RAW.replace(b'SiliconYC',b'other'),RAW.replace(b'vitro_union_lab',b'../repo')]:
   with patch.object(h,'read_secret') as read:self.assertEqual(self.invoke(raw=raw),(1,b''));read.assert_not_called()
 def test_store_erase_no_read_or_write(self):
  for op in ['store','erase']:
   with patch.object(h,'read_secret') as read:self.assertEqual(self.invoke(op),(0,b''));read.assert_not_called()
  self.assertEqual(self.file.read_bytes(),self.fake)
 def test_bad_mode(self):self.file.chmod(0o644);self.assertEqual(self.invoke(),(1,b''))
 def test_bad_directory(self):self.root.chmod(0o755);self.assertEqual(self.invoke(),(1,b''))
 def test_symlink(self):
  link=self.root/'link';link.symlink_to(self.file);h.PAT_FILE=link;self.assertEqual(self.invoke(),(1,b''))
 def test_expired(self):h.EXPIRES_AT='2000-01-01T00:00:00+00:00';self.assertEqual(self.invoke(),(1,b''))
 def test_not_configured(self):h.EXPIRES_AT=None;self.assertEqual(self.invoke(),(1,b''))
 def test_invalid_format(self):self.file.write_bytes(b'FAKE\nSECOND');self.assertEqual(self.invoke(),(1,b''))
 def test_no_push(self):
  import contextlib
  with contextlib.redirect_stderr(io.StringIO()):self.assertEqual(h.main(['push','repo']),2)
 def test_no_path_url_injection(self):
  for name in ['../repo','https://github.com/other/repo','.','repo.git']:
   with self.assertRaises(ValueError):h.repo_name(name)
 def test_clean_env(self):
  with patch.dict(os.environ,{'GIT_TRACE':'1','GITHUB_TOKEN':'FAKE','LD_PRELOAD':'FAKE'}):env=h.clean_environment('/tmp/fake-home')
  self.assertFalse(any(k in env for k in ['GIT_TRACE','GITHUB_TOKEN','LD_PRELOAD']))
 def test_real_git_fake_multivalued_pipe(self):
  script=self.root/'fake-helper.py';source=(HERE/'readonly_git.py').read_text()
  source=source.replace("PAT_FILE = USER_HOME / '.local/share/poly-tally-private/github.pat'",'PAT_FILE = Path('+repr(str(self.file))+')')
  source=source.replace("DIAGNOSTICS = USER_HOME / '.local/state/poly-tally/helper-diagnostics.jsonl'", 'DIAGNOSTICS = Path('+repr(str(self.root/'fake-subprocess-diagnostics.jsonl'))+')')
  source=source.replace('EXPIRES_AT = None','EXPIRES_AT = '+repr(h.EXPIRES_AT));script.write_text(source)
  helper='!"'+sys.executable+'" "'+str(script)+'" --credential-helper'
  raw=RAW.rstrip(b'\n')+b'\nwwwauth[]=Basic realm=FAKE\nwwwauth[]=Bearer FAKE\ncapability[]=authtype\ncapability[]=state\n\n'
  p=subprocess.run([h.GIT,'-c','credential.helper=','-c','credential.helper='+helper,'-c','credential.useHttpPath=true','credential','fill'],input=raw,capture_output=True,env=h.clean_environment(str(self.root)),cwd=self.root)
  self.assertEqual(p.returncode,0);self.assertTrue(b'password='+self.fake in p.stdout);self.assertFalse(p.stderr)
 def test_mirror_malicious_config_rejected(self):
  mirror=self.root/'safe.git';env=h.clean_environment(str(self.root))
  subprocess.run([h.GIT,'init','--bare','--template=',str(mirror)],env=env,capture_output=True,check=True);h.validate_mirror(mirror,env)
  subprocess.run([h.GIT,'--git-dir='+str(mirror),'config','credential.helper','FAKE'],env=env,check=True)
  with self.assertRaises(ValueError):h.validate_mirror(mirror,env)
 def test_metadata_expiry(self):
  expiry=h.EXPIRES_AT;h.EXPIRES_AT=None;(self.root/'metadata.json').write_text(json.dumps({'expires_at':expiry,'status':'user_entered'}));self.assertEqual(self.invoke()[0],0)
 def test_gui_fake_save_and_guard(self):
  spec=importlib.util.spec_from_file_location('gui',HERE/'enter_pat_simple.py');gui=importlib.util.module_from_spec(spec);spec.loader.exec_module(gui)
  gui.PAT=self.file;gui.META=self.root/'metadata.json'
  with self.assertRaises(ValueError):gui.safe_empty_file()
  self.file.write_bytes(b'');inode=self.file.stat().st_ino;gui.save_private('FAKE_TOKEN','2030-01-02')
  self.assertEqual(self.file.stat().st_ino,inode);self.assertEqual(json.loads(gui.META.read_text())['expires_at'],'2030-01-02T00:00:00+00:00')
 def test_default_branch(self):
  self.assertEqual(h.remote_summary('repo',b''),{'repository':'SiliconYC/repo','defaultBranch':None,'head':None})
  self.assertEqual(h.remote_summary('repo',b'ref: refs/heads/dev\tHEAD\n'+b'a'*40+b'\tHEAD\n')['defaultBranch'],'dev')
  self.assertEqual(h.default_branch_from_refs(b'ref: refs/heads/dev\tHEAD\n1234\tHEAD\n'),'refs/heads/dev')
  with self.assertRaises(ValueError):h.default_branch_from_refs(b'1234\tHEAD\n')
  with self.assertRaises(ValueError):h.remote_summary('repo',b'a'*40+b'\trefs/heads/dev\n')
 def test_core_limit(self):
  p=subprocess.run([sys.executable,'-c','import resource;resource.setrlimit(resource.RLIMIT_CORE,(0,0));assert resource.getrlimit(resource.RLIMIT_CORE)==(0,0)'],capture_output=True);self.assertEqual(p.returncode,0)
 def test_platform_proxy_preserved(self):
  with patch.dict(os.environ,{'HTTPS_PROXY':'http://fake.invalid:8080'}):env=h.clean_environment('/tmp/fake')
  self.assertEqual(env['HTTPS_PROXY'],'http://fake.invalid:8080');self.assertNotIn('http.proxy=',h.options())
 def test_diagnostics_no_credential(self):
  self.invoke();self.file.chmod(0o644);self.invoke();log=h.DIAGNOSTICS.read_bytes();self.assertNotIn(self.fake,log);self.assertIn(b'FILE_METADATA_REJECTED',log)
 def test_multi_valued_extensions(self):
  raw=RAW.rstrip(b'\n')+b'\nwwwauth[]=Basic FAKE\nwwwauth[]=Bearer FAKE\ncapability[]=one\ncapability[]=two\n\n'
  self.assertEqual(self.invoke(raw=raw)[0],0);self.assertNotIn(b'Basic FAKE',h.DIAGNOSTICS.read_bytes())
 def test_duplicate_core_diagnostic(self):
  self.assertEqual(self.invoke(raw=RAW.replace(b'protocol=https',b'protocol=https\nprotocol=http')),(1,b''));self.assertIn(b'DUPLICATE_CORE_FIELD',h.DIAGNOSTICS.read_bytes())
if __name__=='__main__':unittest.main(verbosity=2)
