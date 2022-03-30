---
permalink: /spark/sparkstartup
layout: default
---
## Spark集群启动过程

~~别看了，上一篇写得我眼瞎，这篇让我稍微休息两天……~~

不，我又出现了……
这次来分析一下Spark集群的启动过程，local模式没什么好说的，yarn模式是直接提交到yarn执行，
所以来看一下standalone模式。

关于yarn模式的对接，先挖个[坑](/spark/yarn)下次再说吧。

首先一切都从[官方文档](https://spark.apache.org/docs/2.4.0/spark-standalone.html)开始。

Spark standalone模式的启动脚本分别是 `./sbin/start-master.sh` 和 `./sbin/start-slave.sh`。

打开看一下，实际上是 `spark-daemon.sh` 调用了 `org.apache.spark.deploy.master.Master` ,

和 `org.apache.spark.deploy.worker.Worker` 两个主要类，其他的都是载入一些环境配置和环境变量，

最终在脚本里还是通过 [`spark-class`](/spark/appendix/appendix) 提交的。

### Master启动

先从 `org.apache.spark.deploy.master.Master` 开始，
很正常的`main`类，进行[log的注册](/spark/aappendix/#关于Master启动时的log注册),注册完启动。

值得一提的是`main`类里的SparkConf是直接new出来的，直接取了默认配置，这个下次有空再说吧,

接着有一些master特有的启动参数解析，主要是master的ip，port端口和webUI的端口，

传递给`startRpcEnvAndEndpoint`。

总之，启动Master的入口在这个类的伴生对象里，

通过 `startRpcEnvAndEndpoint` 函数返回一个3元tuple，包含以下数据：

- (1) The Master RpcEnv

- (2) The web UI bound port

- (3) The REST server bound port, if any
