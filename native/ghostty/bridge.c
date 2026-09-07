#include <node_api.h>
#include <stdlib.h>
#include <string.h>
extern char *dw_request(void *, const char *);
extern void dw_emit(void (*)(const char *));
static napi_threadsafe_function events;
static void cleanup(void *unused) { dw_emit(NULL); if(events) napi_release_threadsafe_function(events,napi_tsfn_abort); }
static void deliver(napi_env env, napi_value fn, void *context, void *data) {
  if (env && fn) { napi_value text, global, result; napi_create_string_utf8(env,data,NAPI_AUTO_LENGTH,&text); napi_get_global(env,&global); napi_call_function(env,global,fn,1,&text,&result); }
  free(data);
}
static void emit(const char *text) { char *copy=strdup(text); if (napi_call_threadsafe_function(events,copy,napi_tsfn_nonblocking)!=napi_ok) free(copy); }
static napi_value listen(napi_env env, napi_callback_info info) {
  if(events) { napi_throw_error(env,NULL,"Native terminal listener already installed"); return NULL; }
  size_t n=1; napi_value arg, name; napi_get_cb_info(env,info,&n,&arg,NULL,NULL);
  napi_create_string_utf8(env,"ghostty-events",NAPI_AUTO_LENGTH,&name);
  napi_create_threadsafe_function(env,arg,NULL,name,0,1,NULL,NULL,NULL,deliver,&events);
  napi_unref_threadsafe_function(env,events); napi_add_env_cleanup_hook(env,cleanup,NULL); dw_emit(emit); return NULL;
}
static napi_value request(napi_env env,napi_callback_info info) {
  size_t n=2,len=0; napi_value args[2],result; void *handle=NULL,*buf=NULL; size_t size=0;
  napi_get_cb_info(env,info,&n,args,NULL,NULL);
  if(n<1 || napi_get_value_string_utf8(env,args[0],NULL,0,&len)!=napi_ok || len>16*1024*1024) { napi_throw_type_error(env,NULL,"Expected bounded JSON string"); return NULL; }
  char *text=malloc(len+1); napi_get_value_string_utf8(env,args[0],text,len+1,&len);
  if(n==2) { bool is_buffer=false; napi_is_buffer(env,args[1],&is_buffer); if(!is_buffer || napi_get_buffer_info(env,args[1],&buf,&size)!=napi_ok || size!=sizeof(void*)) { free(text); napi_throw_type_error(env,NULL,"Expected native window handle"); return NULL; } memcpy(&handle,buf,sizeof(void*)); }
  char *response=dw_request(handle,text); free(text); napi_create_string_utf8(env,response?response:"{}",NAPI_AUTO_LENGTH,&result); free(response); return result;
}
static napi_value init(napi_env env,napi_value exports) {
  napi_property_descriptor props[]={{"request",NULL,request,NULL,NULL,NULL,napi_default,NULL},{"listen",NULL,listen,NULL,NULL,NULL,napi_default,NULL}};
  napi_define_properties(env,exports,2,props); return exports;
}
NAPI_MODULE(DonwellsGhostty,init)
