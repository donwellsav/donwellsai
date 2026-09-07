#import <AppKit/AppKit.h>
#include <node_api.h>
#include <string>
static NSView *find(NSView *root, NSString *suffix) {
  if (root.hidden) return nil;
  if ([NSStringFromClass([root class]) hasSuffix:suffix] && !root.hidden) return root;
  for (NSView *child in root.subviews) { NSView *hit=find(child,suffix); if(hit) return hit; }
  return nil;
}
static napi_value action(napi_env env,napi_callback_info info) {
 size_t count=2; napi_value args[2],result; napi_get_cb_info(env,info,&count,args,NULL,NULL);
 char op[20],text[4097];size_t size=0;
 if(count!=2||napi_get_value_string_utf8(env,args[0],op,sizeof(op),&size)!=napi_ok||napi_get_value_string_utf8(env,args[1],text,sizeof(text),&size)!=napi_ok){napi_throw_error(env,NULL,"Expected action and text");return NULL;}
 NSView *target=nil;
 for(NSWindow *window in NSApp.windows){target=find(window.contentView,strcmp(op,"search")==0?@"NSSearchField":@"TerminalView");if(target)break;}
 if(!target){napi_throw_error(env,NULL,"Native view missing");return NULL;}
 if(strcmp(op,"focused")==0){napi_get_boolean(env,target.window.firstResponder==target,&result);return result;}
 if(strcmp(op,"search")==0){NSSearchField *field=(NSSearchField*)target;field.stringValue=[NSString stringWithUTF8String:text];[NSApp sendAction:field.action to:field.target from:field];}
 else {
  [target.window makeFirstResponder:target];
  NSString *characters=[NSString stringWithUTF8String:text];
  NSEvent *event=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:strcmp(op,"shortcut")==0?NSEventModifierFlagCommand:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:target.window.windowNumber context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:strcmp(op,"shortcut")==0?40:7];
  [target keyDown:event];
 }
 napi_get_boolean(env,true,&result);return result;
}
static napi_value init(napi_env env,napi_value exports){napi_value fn;napi_create_function(env,"action",NAPI_AUTO_LENGTH,action,NULL,&fn);napi_set_named_property(env,exports,"action",fn);return exports;}
NAPI_MODULE(native_probe,init)
