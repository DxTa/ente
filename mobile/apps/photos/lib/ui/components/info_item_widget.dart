import "package:flutter/widgets.dart";

typedef InfoItemBuilder<T> = Widget Function(BuildContext context, T data);
typedef InfoItemErrorBuilder =
    Widget Function(BuildContext context, Object error, StackTrace? stackTrace);

/// Loads data once for a menu row and keeps using that result across rebuilds.
///
/// Change this widget's key when the data should be loaded again.
class InfoItemWidget<T> extends StatefulWidget {
  const InfoItemWidget({
    required this.load,
    required this.builder,
    required this.placeholder,
    this.errorBuilder,
    super.key,
  });

  final Future<T> Function() load;
  final InfoItemBuilder<T> builder;
  final Widget placeholder;
  final InfoItemErrorBuilder? errorBuilder;

  @override
  State<InfoItemWidget<T>> createState() => _InfoItemWidgetState<T>();
}

class _InfoItemWidgetState<T> extends State<InfoItemWidget<T>> {
  late final Future<T> _future;

  @override
  void initState() {
    super.initState();
    _future = Future<T>.sync(widget.load);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: _future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return widget.placeholder;
        }
        if (snapshot.hasError) {
          return widget.errorBuilder?.call(
                context,
                snapshot.error!,
                snapshot.stackTrace,
              ) ??
              widget.placeholder;
        }
        return widget.builder(context, snapshot.data as T);
      },
    );
  }
}
