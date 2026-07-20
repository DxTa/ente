import "package:ente_components/ente_components.dart";
import "package:exif_reader/exif_reader.dart";
import "package:flutter/material.dart";
import "package:hugeicons/hugeicons.dart";
import "package:photos/generated/l10n.dart";
import "package:photos/models/file/file.dart";

Future<void> showExifInfoSheet({
  required BuildContext context,
  required EnteFile file,
  required Map<String, IfdTag> exif,
}) {
  return showBottomSheetComponent<void>(
    context: context,
    builder: (_) => _DraggableExifSheet(file: file, exif: exif),
  );
}

class _DraggableExifSheet extends StatefulWidget {
  const _DraggableExifSheet({required this.file, required this.exif});

  final EnteFile file;
  final Map<String, IfdTag> exif;

  @override
  State<_DraggableExifSheet> createState() => _DraggableExifSheetState();
}

class _DraggableExifSheetState extends State<_DraggableExifSheet> {
  final _sheetController = DraggableScrollableController();
  bool _isExpanded = false;

  @override
  void initState() {
    super.initState();
    _sheetController.addListener(_onSheetSizeChanged);
  }

  @override
  void dispose() {
    _sheetController.removeListener(_onSheetSizeChanged);
    _sheetController.dispose();
    super.dispose();
  }

  void _onSheetSizeChanged() {
    final isNowExpanded = _sheetController.size >= 0.75;
    if (isNowExpanded == _isExpanded) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || isNowExpanded == _isExpanded) return;
      setState(() {
        _isExpanded = isNowExpanded;
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      controller: _sheetController,
      initialChildSize: _isExpanded ? 0.95 : 0.75,
      minChildSize: _isExpanded ? 0.75 : 0.5,
      maxChildSize: 0.95,
      snap: !_isExpanded,
      snapSizes: _isExpanded ? null : const [0.75],
      expand: false,
      builder: (context, scrollController) => ExifInfoDialog(
        widget.file,
        widget.exif,
        scrollController: scrollController,
      ),
    );
  }
}

class ExifInfoDialog extends StatelessWidget {
  const ExifInfoDialog(
    this.file,
    this.exif, {
    required this.scrollController,
    super.key,
  });

  final EnteFile file;
  final Map<String, IfdTag> exif;
  final ScrollController scrollController;

  @override
  Widget build(BuildContext context) {
    final colors = context.componentColors;
    final l10n = AppLocalizations.of(context);
    final exifText = exif.isEmpty
        ? l10n.noExifData
        : exif.entries
              .map((entry) => "${entry.key}: ${entry.value}")
              .join("\n");
    final scrollSections = <Widget>[
      _ExifInfoHeader(title: l10n.exif, closeTooltip: l10n.close),
      const SizedBox(height: Spacing.lg),
      Text(
        file.title!,
        style: TextStyles.body.copyWith(color: colors.textLight),
      ),
      const SizedBox(height: Spacing.lg),
      Text(exifText, style: TextStyles.body.copyWith(color: colors.textLight)),
    ];

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: colors.backgroundBase,
        borderRadius: const BorderRadius.only(
          topLeft: Radius.circular(Radii.bottomSheet),
          topRight: Radius.circular(Radii.bottomSheet),
        ),
      ),
      child: SafeArea(
        top: false,
        child: CustomScrollView(
          controller: scrollController,
          physics: const ClampingScrollPhysics(),
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.all(Spacing.xl),
              sliver: SliverList(
                delegate: SliverChildBuilderDelegate(
                  (context, index) => scrollSections[index],
                  childCount: scrollSections.length,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ExifInfoHeader extends StatelessWidget {
  const _ExifInfoHeader({required this.title, required this.closeTooltip});

  final String title;
  final String closeTooltip;

  @override
  Widget build(BuildContext context) {
    final colors = context.componentColors;
    return SizedBox(
      height: 38,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyles.h2.copyWith(color: colors.textBase),
            ),
          ),
          const SizedBox(width: Spacing.md),
          IconButtonComponent(
            tooltip: closeTooltip,
            variant: IconButtonComponentVariant.circular,
            shouldSurfaceExecutionStates: false,
            icon: const HugeIcon(
              icon: HugeIcons.strokeRoundedCancel01,
              size: IconSizes.small,
            ),
            onTap: () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }
}
