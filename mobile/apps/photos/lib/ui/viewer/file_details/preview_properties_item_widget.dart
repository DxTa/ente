import "package:ente_components/ente_components.dart";
import "package:ente_pure_utils/ente_pure_utils.dart";
import "package:flutter/material.dart";
import "package:hugeicons/hugeicons.dart";
import "package:photos/generated/l10n.dart";
import "package:photos/models/ffmpeg/ffprobe_props.dart";
import 'package:photos/models/file/file.dart';
import "package:photos/models/file/file_type.dart";
import "package:photos/services/video_preview_service.dart";
import "package:photos/ui/common/loading_widget.dart";
import "package:photos/ui/components/info_item_widget.dart";

class PreviewPropertiesItemWidget extends StatelessWidget {
  final EnteFile file;
  final bool isImage;
  final Map<String, dynamic> exifData;
  final int currentUserID;
  const PreviewPropertiesItemWidget(
    this.file,
    this.isImage,
    this.exifData,
    this.currentUserID, {
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    return InfoItemWidget<String?>(
      key: ValueKey("preview-properties-${file.tag}"),
      load: _loadSubtitle,
      placeholder: _menuItem(context, isLoading: true),
      errorBuilder: (context, error, stackTrace) => const SizedBox.shrink(),
      builder: (context, subtitle) => subtitle == null
          ? const SizedBox.shrink()
          : _menuItem(context, subtitle: subtitle),
    );
  }

  Widget _menuItem(
    BuildContext context, {
    String? subtitle,
    bool isLoading = false,
  }) {
    final colors = context.componentColors;
    return MenuComponent(
      key: const ValueKey("Stream properties"),
      leading: HugeIcon(
        icon: HugeIcons.strokeRoundedPlay,
        size: IconSizes.small,
        color: colors.textLight,
      ),
      title: AppLocalizations.of(context).streamDetails,
      subtitle: subtitle ?? (isLoading ? "…" : null),
      trailing: isLoading
          ? const EnteLoadingWidget(size: IconSizes.small, padding: 0)
          : null,
    );
  }

  Future<String?> _loadSubtitle() async {
    final file = this.file;
    final parts = <String>[];
    try {
      final data = await VideoPreviewService.instance.getPlaylist(file).onError(
        (error, stackTrace) {
          return null;
        },
      );

      if (data != null) {
        if (data.width != null && data.height != null) {
          parts.add("${data.width!}x${data.height!}");
        }

        if (data.size != null) {
          parts.add(formatBytes(data.size!));
        }

        if ((file.fileType == FileType.video) &&
            (file.localID != null || file.duration != 0) &&
            data.size != null) {
          final result = FFProbeProps.formatBitrate(
            data.size! * 8 / file.duration!,
            "b/s",
          );
          if (result != null) {
            parts.add(result);
          }
        }
      }
    } catch (_) {
      parts.clear();
    }
    return parts.isEmpty ? null : parts.join("   ");
  }
}
