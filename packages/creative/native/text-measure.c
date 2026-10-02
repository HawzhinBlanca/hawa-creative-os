/* ADR-118: bounded, application-owned protocol over stable Pango APIs. */
#include <pango/pangocairo.h>
#include <pango/pangofc-font.h>
#include <fontconfig/fontconfig.h>
#include <hb.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HAWA_MAX_INPUT 16384
#define HAWA_MAX_LINES 512
static unsigned lines = 0;

static void string_json(const char *s) {
  putchar('"');
  for (const unsigned char *p=(const unsigned char *)s; *p; ++p) {
    if (*p=='"' || *p=='\\') { putchar('\\'); putchar(*p); }
    else if (*p<32) printf("\\u%04x",*p);
    else putchar(*p);
  }
  putchar('"');
}

static void runtime(void) {
  printf("\"pango=%s;cairo=%s;fontconfig=%d;harfbuzz=%s;language=%s\"",pango_version_string(),cairo_version_string(),FcGetVersion(),hb_version_string(),pango_language_to_string(pango_language_get_default()));
}

static double number(const char *s,double min,double max) {
  char *end=NULL; double n=strtod(s,&end);
  if (!*s || *end || !isfinite(n) || n<min || n>max) exit(2);
  return n;
}

static void set_text(PangoLayout *layout,const char *text,gboolean rtl) {
  char *wrapped=rtl && *text ? g_strconcat("\342\200\253",text,"\342\200\254",NULL):g_strdup(text);
  pango_layout_set_text(layout,wrapped,-1);g_free(wrapped);
}

static double advance(PangoLayout *layout,const char *text,gboolean rtl) {
  set_text(layout,text,rtl);
  PangoRectangle logical;pango_layout_get_extents(layout,NULL,&logical);
  return (double)logical.width/PANGO_SCALE;
}

static void emit_line(PangoLayout *layout,const char *text,gboolean rtl) {
  if (++lines>HAWA_MAX_LINES) exit(3);
  set_text(layout,text,rtl);
  PangoRectangle ink,logical;pango_layout_get_extents(layout,&ink,&logical);
  int baseline=pango_layout_get_baseline(layout);
  if (lines>1) putchar(',');
  printf("{\"text\":");string_json(text);
  printf(",\"width\":%.9f,\"ink\":{\"x\":%.9f,\"y\":%.9f,\"width\":%.9f,\"height\":%.9f},\"unknownGlyphs\":%d,\"fonts\":[",
    (double)logical.width/PANGO_SCALE,(double)ink.x/PANGO_SCALE,(double)(ink.y-baseline)/PANGO_SCALE,
    (double)ink.width/PANGO_SCALE,(double)ink.height/PANGO_SCALE,pango_layout_get_unknown_glyphs_count(layout));
  PangoLayoutIter *iter=pango_layout_get_iter(layout);gboolean first=TRUE;
  GArray *missing=g_array_new(FALSE,FALSE,sizeof(guint32));
  do {
    PangoLayoutRun *run=pango_layout_iter_get_run_readonly(iter);
    if (!run || !run->item->analysis.font) continue;
    for (int i=0;i<run->glyphs->num_glyphs;i++) {
      PangoGlyph glyph=run->glyphs->glyphs[i].glyph;
      if (glyph & PANGO_GLYPH_UNKNOWN_FLAG) {
        guint32 cp=glyph & ~PANGO_GLYPH_UNKNOWN_FLAG;
        g_array_append_val(missing,cp);
      }
    }
    if (!PANGO_IS_FC_FONT(run->item->analysis.font)) exit(4);
    FcPattern *pattern=pango_fc_font_get_pattern(PANGO_FC_FONT(run->item->analysis.font));
    FcChar8 *file=NULL;int index=0;
    if (FcPatternGetString(pattern,FC_FILE,0,&file)!=FcResultMatch) exit(4);
    if (FcPatternGetInteger(pattern,FC_INDEX,0,&index)!=FcResultMatch) exit(4);
    if (!first) putchar(',');
    first=FALSE;
    printf("{\"file\":");string_json((const char *)file);printf(",\"index\":%d}",index);
  } while (pango_layout_iter_next_run(iter));
  pango_layout_iter_free(iter);printf("],\"missingCodePoints\":[");
  for (guint i=0;i<missing->len;i++) {if (i) putchar(',');printf("%u",g_array_index(missing,guint32,i));}
  g_array_free(missing,TRUE);printf("]}");
}

int main(int argc,char **argv) {
  if (argc==2 && strcmp(argv[1],"--identity")==0) {printf("{\"version\":1,\"runtime\":");runtime();puts("}");return 0;}
  if (argc!=7) return 2;
  double size=number(argv[1],1,4096),width=number(argv[2],0.001,1000000),spacing=number(argv[3],-4096,4096);
  /* ADR-275: argument 5 is 0 (regular), 1 (bold) or a CSS weight 100..1000. */
  double weight_arg=number(argv[5],0,1000);
  if (weight_arg!=0 && weight_arg!=1 && (weight_arg<100 || weight_arg!=floor(weight_arg))) return 2;
  gboolean rtl=number(argv[4],0,1)==1,italic=number(argv[6],0,1)==1;
  int weight=weight_arg>=100?(int)weight_arg:weight_arg==1?PANGO_WEIGHT_BOLD:PANGO_WEIGHT_NORMAL;
  char input[HAWA_MAX_INPUT+1];size_t count=fread(input,1,sizeof(input),stdin);
  if (count>HAWA_MAX_INPUT || ferror(stdin) || memchr(input,0,count) || !g_utf8_validate(input,(gssize)count,NULL)) return 2;
  input[count]=0;char *text=strchr(input,'\n');if (!text || text==input || text-input>256) return 2;*text++=0;
  PangoFontMap *map=pango_cairo_font_map_new();
  PangoContext *ctx=pango_font_map_create_context(map);
  pango_cairo_context_set_resolution(ctx,72);
  pango_context_set_round_glyph_positions(ctx,FALSE);
  pango_context_set_base_dir(ctx,PANGO_DIRECTION_LTR);
  cairo_font_options_t *options=cairo_font_options_create();
  cairo_font_options_set_hint_style(options,CAIRO_HINT_STYLE_NONE);
  cairo_font_options_set_hint_metrics(options,CAIRO_HINT_METRICS_OFF);
  pango_cairo_context_set_font_options(ctx,options);cairo_font_options_destroy(options);
  PangoLayout *layout=pango_layout_new(ctx);pango_layout_set_auto_dir(layout,FALSE);
  PangoFontDescription *font=pango_font_description_new();
  pango_font_description_set_family(font,input);pango_font_description_set_absolute_size(font,size*PANGO_SCALE);
  pango_font_description_set_weight(font,(PangoWeight)weight);
  pango_font_description_set_style(font,italic?PANGO_STYLE_ITALIC:PANGO_STYLE_NORMAL);
  pango_layout_set_font_description(layout,font);pango_font_description_free(font);
  PangoAttrList *attrs=pango_attr_list_new();pango_attr_list_insert(attrs,pango_attr_letter_spacing_new((int)round(spacing*PANGO_SCALE)));
  pango_layout_set_attributes(layout,attrs);pango_attr_list_unref(attrs);
  printf("{\"version\":1,\"runtime\":");runtime();printf(",\"lines\":[");
  /* JS normalizes whitespace exactly as the existing greedy wrapper does. */
  char **paragraphs=g_strsplit(text,"\n",-1);
  for (char **p=paragraphs;*p;++p) {
    char **words=g_strsplit(*p," ",-1);GString *current=g_string_new(words[0]);
    for (unsigned i=1;words[i];++i) {
      char *candidate=g_strconcat(current->str," ",words[i],NULL);
      if (advance(layout,candidate,rtl)<=width) g_string_assign(current,candidate);
      else {emit_line(layout,current->str,rtl);g_string_assign(current,words[i]);}
      g_free(candidate);
    }
    emit_line(layout,current->str,rtl);g_string_free(current,TRUE);g_strfreev(words);
  }
  g_strfreev(paragraphs);puts("]}");g_object_unref(layout);g_object_unref(ctx);g_object_unref(map);return 0;
}
