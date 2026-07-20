import "package:ente_components/ente_components.dart";
import "package:ente_pure_utils/ente_pure_utils.dart";
import "package:flutter/material.dart";
import "package:hugeicons/hugeicons.dart";
import 'package:path/path.dart' as path;
import "package:photos/models/file/extensions/file_props.dart";
import 'package:photos/models/file/file.dart';
import 'package:photos/models/file/file_type.dart';
import "package:photos/module/download/file.dart";
import "package:photos/ui/common/loading_widget.dart";
import "package:photos/ui/components/info_item_widget.dart";
import "package:photos/utils/image_util.dart";
import "package:photos/utils/magic_util.dart";

typedef _FilePropertiesData = ({
  int? width,
  int? height,
  int fileSize,
  String? duration,
});

class FilePropertiesItemWidget extends StatefulWidget {
  final EnteFile file;
  final bool isImage;
  final Map<String, dynamic> exifData;
  final int currentUserID;
  const FilePropertiesItemWidget(
    this.file,
    this.isImage,
    this.exifData,
    this.currentUserID, {
    super.key,
  });
  @override
  State<FilePropertiesItemWidget> createState() =>
      _FilePropertiesItemWidgetState();
}

class _FilePropertiesItemWidgetState extends State<FilePropertiesItemWidget> {
  @override
  Widget build(BuildContext context) {
    final canEdit =
        !(widget.file.uploadedFileID == null ||
            widget.file.ownerID != widget.currentUserID ||
            widget.file.isTrash);
    final title =
        path.basenameWithoutExtension(widget.file.displayName) +
        path.extension(widget.file.displayName).toUpperCase();
    return InfoItemWidget<_FilePropertiesData>(
      key: ValueKey("file-properties-${widget.file.tag}"),
      load: _loadProperties,
      placeholder: _menuItem(
        context,
        title: title,
        subtitle: "…",
        canEdit: canEdit,
        isLoading: true,
      ),
      errorBuilder: (context, error, stackTrace) =>
          _menuItem(context, title: title, canEdit: canEdit),
      builder: (context, data) => _menuItem(
        context,
        title: title,
        subtitle: _subtitle(data),
        canEdit: canEdit,
      ),
    );
  }

  Widget _menuItem(
    BuildContext context, {
    required String title,
    required bool canEdit,
    String? subtitle,
    bool isLoading = false,
  }) {
    final colors = context.componentColors;
    return MenuComponent(
      key: const ValueKey("File properties"),
      leading: HugeIcon(
        icon: widget.isImage
            ? HugeIcons.strokeRoundedImage01
            : HugeIcons.strokeRoundedVideo02,
        size: IconSizes.small,
        color: colors.textLight,
      ),
      title: title,
      subtitle: subtitle,
      trailing: isLoading
          ? const EnteLoadingWidget(size: IconSizes.small, padding: 0)
          : canEdit
          ? IconButtonComponent(
              icon: HugeIcon(
                icon: HugeIcons.strokeRoundedEdit03,
                size: IconSizes.small,
                color: colors.textLight,
              ),
              variant: IconButtonComponentVariant.secondary,
              shouldSurfaceExecutionStates: false,
              onTap: () async {
                await editFilename(context, widget.file);
                setState(() {});
              },
            )
          : null,
    );
  }

  Future<_FilePropertiesData> _loadProperties() async {
    final file = widget.file;
    final isImage = widget.isImage;
    int? width;
    int? height;
    if (file.hasDimensions) {
      width = file.width;
      height = file.height;
    } else if (isImage) {
      // No saved public dimensions (local-only / not-yet-backed-up / removed
      // from Ente). Derive from the actual current local file bytes so we show
      // the real rendered size instead of the (often stale) EXIF tag. Uses the
      // non-origin file (asset.file on iOS = the current rendered image).
      try {
        final localFile = await getFile(file);
        final decoded = localFile != null
            ? await getImageDimensions(imagePath: localFile.path)
            : null;
        if (decoded != null) {
          width = decoded.width;
          height = decoded.height;
        }
      } catch (_) {}
    }

    final int fileSize;
    if (file.fileSize != null) {
      fileSize = file.fileSize!;
    } else {
      fileSize = await getFile(file).then((f) => f!.length());
    }

    String? duration;
    if (file.fileType == FileType.video &&
        (file.localID != null || file.duration != 0)) {
      if (file.duration != 0) {
        duration = secondsToHHMMSS(file.duration!);
      } else {
        final asset = await file.getAsset;
        final assetDuration =
            asset?.videoDuration.toString().split(".")[0] ?? "";
        if (assetDuration.isNotEmpty) {
          duration = assetDuration;
        }
      }
    }

    return (
      width: width,
      height: height,
      fileSize: fileSize,
      duration: duration,
    );
  }

  String _subtitle(_FilePropertiesData data) {
    final parts = <String>[];
    final StringBuffer dimString = StringBuffer();
    final width = data.width;
    final height = data.height;
    if (width != null && height != null && width != 0 && height != 0) {
      final double megaPixels = (width * height) / 1000000;
      final double roundedMegaPixels = (megaPixels * 10).round() / 10.0;
      dimString.write('${roundedMegaPixels.toStringAsFixed(1)}MP   ');
      dimString.write('$width x $height');
    } else if (widget.exifData["resolution"] != null &&
        widget.exifData["megaPixels"] != null) {
      dimString.write('${widget.exifData["megaPixels"]}MP   ');
      dimString.write('${widget.exifData["resolution"]}');
    }

    if (dimString.isNotEmpty) {
      parts.add(dimString.toString());
    }

    parts.add(formatBytes(data.fileSize));

    if (data.duration != null) {
      parts.add(data.duration!);
    }

    return parts.join("   ");
  }
}
