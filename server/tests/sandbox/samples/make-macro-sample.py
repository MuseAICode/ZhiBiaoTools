# 生成 macro-autorun.odt（解析沙箱的宏安全测试样本，tests/sandbox/docker/parse.test.ts）。
# 文档中的 Basic 宏绑定到“打开文档”等事件（OnLoad、OnViewCreated、OnFocus、OnLayoutFinished），执行时在 /tmp 写标记文件
# /tmp/zhibiao-macro-marker。事件格式由 LibreOffice 自己保存，不手写 XML。用法（需要 LibreOffice 与 Python-UNO）：
#   soffice --headless --accept="socket,host=127.0.0.1,port=2099;urp;" &
#   python3 make-macro-sample.py /absolute/path/macro-autorun.odt
import sys
import time

import uno
from com.sun.star.beans import PropertyValue

EVENTS = ('OnLoad', 'OnViewCreated', 'OnFocus', 'OnLayoutFinished')
CODE = '''Sub Main
  Dim n As Integer
  n = FreeFile()
  Open "/tmp/zhibiao-macro-marker" For Output As #n
  Print #n, "macro executed"
  Close #n
End Sub
'''


def prop(name, value):
    item = PropertyValue()
    item.Name = name
    item.Value = value
    return item


local = uno.getComponentContext()
resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
for _ in range(60):
    try:
        ctx = resolver.resolve('uno:socket,host=127.0.0.1,port=2099;urp;StarOffice.ComponentContext')
        break
    except Exception:
        time.sleep(0.5)
desktop = ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', ctx)
doc = desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, (prop('Hidden', True),))
doc.getText().setString('宏样本：打开文档时自动运行的宏不应执行。')
libraries = doc.BasicLibraries
library = libraries.getByName('Standard') if libraries.hasByName('Standard') else libraries.createLibrary('Standard')
library.insertByName('Module1', CODE)
events = doc.getEvents()
script = 'vnd.sun.star.script:Standard.Module1.Main?language=Basic&location=document'
for name in EVENTS:
    binding = uno.Any('[]com.sun.star.beans.PropertyValue', (prop('EventType', 'Script'), prop('Script', script)))
    uno.invoke(events, 'replaceByName', (name, binding))
doc.storeToURL('file://' + sys.argv[1], (prop('FilterName', 'writer8'),))
doc.close(True)
