import unittest
from tests import test_engine as _engine
from poly_tally.git import Git对象_类

class TestNativeFactory(unittest.TestCase):
    setUp = _engine.Test历史_类.setUp
    _git = _engine.Test历史_类._git
    _提交 = _engine.Test历史_类._提交
    def test_private_wrapper_reads_local_objects_without_secret_access(self):
        from poly_tally.native_session import NativeDiscovery
        import subprocess
        first=self._提交({'a.py':'x=1\n'})
        mirror=self.根/'mirror.git'
        subprocess.run(['git','clone','--bare',str(self.源),str(mirror)],check=True,capture_output=True)
        script=self.根/'fake_wrapper.py'
        receipt={'repository':'SiliconYC/example','defaultBranch':'main','head':first,'path':str(mirror)}
        script.write_text('import json\nprint('+repr(__import__('json').dumps(receipt))+')\n')
        data=manifest();row=data['repositories'][0];row.update(private=True,default_branch='main')
        discovery=NativeDiscovery(data,script)
        self.引擎.对象工厂=discovery.object_factory
        head=discovery.api_读取默认分支(row)
        state=self.引擎.api_同步(row,row['clone_url'],head)
        self.assertEqual(state['history'][-1]['metrics']['code'],1)
        script.unlink()  # Unchanged HEAD must not require fetch wrapper again.
        self.引擎.api_同步(row,row['clone_url'],head)
        self.assertEqual(self.引擎.计数['unchangedRepositories'],1)

    def test_factory_is_lazy_and_incremental(self):
        calls=[]
        def factory(meta,path):
            calls.append(meta['id'])
            return Git对象_类(path)
        self.引擎.对象工厂=factory
        first=self._提交({'a.py':'x=1\n'})
        self.引擎.api_同步(self.元数据,str(self.源),first)
        self.引擎.api_同步(self.元数据,str(self.源),first)
        self.assertEqual(calls,[1])
        second=self._提交({'a.py':'x=1\ny=2\n'})
        self.引擎.api_同步(self.元数据,str(self.源),second)
        self.assertEqual(calls,[1,1])
        self.assertEqual(self.引擎.计数['recomputedCommits'],2)

import copy
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
import pytest
from poly_tally.native_session import NativeDiscovery, safe_environment


def manifest():
    return {'schemaVersion':1,'complete':True,'generatedAt':datetime.now(timezone.utc).isoformat(),'owners':['SiliconYC'], 'repositories':[{'id':1,'full_name':'SiliconYC/example','clone_url':'https://github.com/SiliconYC/example.git','owner':{'login':'SiliconYC'},'default_branch':'dev','private':False,'archived':False,'fork':False,'size':1}]}

@pytest.mark.parametrize('field,value',[('complete',False),('generatedAt','2020-01-01T00:00:00+00:00')])
def test_incomplete_stale_inventory_rejected(field,value):
    data=manifest();data[field]=value
    with pytest.raises(ValueError):NativeDiscovery(data)

def test_missing_fork_is_not_guessed():
    data=manifest();del data['repositories'][0]['fork']
    with pytest.raises(ValueError):NativeDiscovery(data)

def test_scope_mismatch_rejected():
    with pytest.raises(ValueError):NativeDiscovery(manifest()).api_发现(['other'])

def test_private_requires_wrapper():
    data=manifest();data['repositories'][0]['private']=True
    discovery=NativeDiscovery(data)
    with pytest.raises(RuntimeError):discovery.api_读取默认分支(data['repositories'][0])

@pytest.mark.parametrize('output', ['a'*40+'\trefs/heads/dev\n', 'ref: refs/heads/main\tHEAD\n'+'a'*40+'\tHEAD\n'])
def test_unresolved_or_changed_default_is_not_empty(output):
    discovery=NativeDiscovery(manifest())
    with patch('poly_tally.native_session.run_git',return_value=output),pytest.raises(RuntimeError):
        discovery.api_读取默认分支(discovery.rows[0])

def test_empty_requires_successful_full_refs_response():
    discovery=NativeDiscovery(manifest())
    with patch('poly_tally.native_session.run_git',return_value=''):
        assert discovery.api_读取默认分支(discovery.rows[0]) is None

def test_environment_token_rejected_without_reading(monkeypatch):
    monkeypatch.setenv('POLY_TALLY_TOKEN','FAKE_TOKEN_DO_NOT_USE')
    with pytest.raises(RuntimeError):safe_environment()

def test_trace_and_injected_config_removed(monkeypatch):
    monkeypatch.setenv('GIT_TRACE','1');monkeypatch.setenv('GIT_CONFIG_COUNT','1')
    env=safe_environment()
    assert 'GIT_TRACE' not in env and 'GIT_CONFIG_COUNT' not in env

def test_public_only_cannot_export(monkeypatch,tmp_path):
    from poly_tally.native_session import main
    monkeypatch.setattr('sys.argv',['native','--inventory','unused','--state',str(tmp_path/'state'),'--cache',str(tmp_path/'cache'),'--report',str(tmp_path/'report'),'--export-dir',str(tmp_path/'export'),'--public-only'])
    with pytest.raises(SystemExit) as exc:main()
    assert exc.value.code==2 and not (tmp_path/'export').exists()

def test_old_publication_inputs_not_reused(monkeypatch,tmp_path):
    from poly_tally.native_session import main
    output=tmp_path/'export';output.mkdir();(output/'private-metrics.json').write_text('prior safe batch')
    monkeypatch.setattr('sys.argv',['native','--inventory','unused','--state',str(tmp_path/'state'),'--cache',str(tmp_path/'cache'),'--report',str(tmp_path/'report'),'--export-dir',str(output)])
    with pytest.raises(SystemExit) as exc:main()
    assert exc.value.code==2 and (output/'private-metrics.json').read_text()=='prior safe batch'

def test_failed_unified_batch_leaves_no_publication_inputs(monkeypatch,tmp_path):
    import json
    from types import SimpleNamespace
    from poly_tally.native_session import main
    (tmp_path/'inventory.json').write_text(json.dumps(manifest()))
    (tmp_path/'config.json').write_text(json.dumps({'datasetEpoch':'fixture'}))
    engine=SimpleNamespace(api_关闭=lambda:None)
    fake=SimpleNamespace(引擎=engine,api_采集=lambda:{'failed':1,'completeness':{'complete':False}})
    monkeypatch.setattr('poly_tally.native_session.采集器_类',lambda *a,**kw:fake)
    monkeypatch.setattr('sys.argv',['native','--config',str(tmp_path/'config.json'),'--inventory',str(tmp_path/'inventory.json'),'--state',str(tmp_path/'state'),'--cache',str(tmp_path/'cache'),'--report',str(tmp_path/'report.json'),'--export-dir',str(tmp_path/'export')])
    assert main()==2
    assert not (tmp_path/'export').exists()
    assert json.loads((tmp_path/'report.json').read_text())['failed']==1
