#!/usr/bin/python3
"""Two-field GTK entry. No existing PAT reads or temporary secret copies."""
import datetime as dt
import json
import os
import pwd
from pathlib import Path
import resource
import stat
PAT=Path(pwd.getpwuid(os.getuid()).pw_dir)/'.local/share/poly-tally-private/github.pat'
META=PAT.parent/'metadata.json'

def safe_empty_file():
    directory=PAT.parent.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid!=os.getuid() or stat.S_IMODE(directory.st_mode)!=0o700:
        raise ValueError('directory validation failed')
    fd=os.open(PAT,os.O_WRONLY|os.O_NOFOLLOW)
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1 or info.st_size!=0:
        os.close(fd);raise ValueError('empty file validation failed')
    return fd

def save_private(value,expiry_text):
    supplied=expiry_text.strip();date_only=len(supplied)==10
    if date_only:
        expiry=dt.datetime.combine(dt.date.fromisoformat(supplied),dt.time.min,tzinfo=dt.timezone.utc)
    else:
        expiry=dt.datetime.fromisoformat(supplied.replace('Z','+00:00'))
    if expiry.tzinfo is None or expiry<=dt.datetime.now(dt.timezone.utc):raise ValueError('invalid expiry')
    raw=value.strip().encode('ascii')
    if not raw or len(raw)>4096 or not all(33<=c<=126 for c in raw):raise ValueError('invalid format')
    metadata={'expires_at':expiry.astimezone(dt.timezone.utc).isoformat(),'entered_at':dt.datetime.now(dt.timezone.utc).isoformat(),
              'status':'pending_write','path':str(PAT),'datePrecision':'day' if date_only else 'timestamp',
              'conservativeCutoff':date_only,'user_supplied_expiry':supplied}
    fd=safe_empty_file()
    try:
        mfd=os.open(META,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(mfd,'w') as output:
            json.dump(metadata,output);output.flush();os.fsync(output.fileno())
        view=memoryview(raw)
        while view:
            count=os.write(fd,view)
            if count<=0:raise OSError('write failed')
            view=view[count:]
        os.fsync(fd)
    finally:os.close(fd)
    metadata['status']='user_entered'
    mfd=os.open(META,os.O_WRONLY|os.O_TRUNC|os.O_NOFOLLOW)
    with os.fdopen(mfd,'w') as output:
        json.dump(metadata,output);output.flush();os.fsync(output.fileno())

def main():
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    try:fd=safe_empty_file();os.close(fd)
    except Exception:
        print('Input refused: private empty-file metadata check failed.');return 1
    import gi
    gi.require_version('Gtk','3.0')
    from gi.repository import Gtk
    window=Gtk.Window(title='保存 GitHub PAT');window.set_default_size(460,180);window.set_resizable(False)
    window.connect('destroy',Gtk.main_quit)
    box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=10);box.set_border_width(20);window.add(box)
    label=Gtk.Label(label='GitHub PAT（非账户密码）');label.set_xalign(0);box.pack_start(label,False,False,0)
    field=Gtk.Entry();field.set_visibility(False);field.set_invisible_char('●');box.pack_start(field,False,False,0)
    label=Gtk.Label(label='过期日期（YYYY-MM-DD，按GitHub显示）');label.set_xalign(0);box.pack_start(label,False,False,0)
    expiry_field=Gtk.Entry();box.pack_start(expiry_field,False,False,0)
    def save(_):
        try:save_private(field.get_text(),expiry_field.get_text())
        except Exception:
            dialog=Gtk.MessageDialog(transient_for=window,flags=0,message_type=Gtk.MessageType.ERROR,buttons=Gtk.ButtonsType.OK,text='未保存：请检查 PAT 和过期日期。')
            dialog.format_secondary_text('日期请填 YYYY-MM-DD。若仍失败，请让助手仅检查文件权限与状态。')
            dialog.run();dialog.destroy();return
        field.set_text('');expiry_field.set_text('');window.destroy()
    button=Gtk.Button(label='保存并关闭');button.connect('clicked',save);box.pack_start(button,False,False,0)
    window.show_all();field.grab_focus();Gtk.main();return 0

if __name__=='__main__':raise SystemExit(main())
