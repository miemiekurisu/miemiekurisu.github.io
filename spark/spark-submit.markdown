---
permalink: /spark/spark-submit
layout: default
---
## Spark任务提交

使用spark程序的主要入口是spark-submit和spark-shell。
源代码里位于 `$SPARK_HOME/bin/spark-submit` 和 `$SPARK_HOME/bin/spark-shell`。
其实就是2个shell脚本，主要调用了 `org.apache.spark.deploy.SparkSubmit`，不同的是spark-shell用 `-class` 指定了`org.apache.spark.repl.Main`参数作为submit的主要执行对象。

### 任务提交入口

所以我们的应用端提交程序入口在 `org.apache.spark.deploy.SparkSubmit` 类里，其伴生对象main函数：

```scala
object SparkSubmit extends CommandLineUtils with Logging {

  // Cluster managers 定义了一些集群管理常量
  ...
  // Deploy modes 部署模式常量
  ...
  // Special primary resource names that represent shells rather than application jars.
  ...

    override def main(args: Array[String]): Unit = {
    val submit = new SparkSubmit() {
      self =>

      override protected def parseArguments(args: Array[String]): SparkSubmitArguments = {
        new SparkSubmitArguments(args) {
          override protected def logInfo(msg: => String): Unit = self.logInfo(msg)

          override protected def logWarning(msg: => String): Unit = self.logWarning(msg)
        }
      }

      override protected def logInfo(msg: => String): Unit = printMessage(msg)

      override protected def logWarning(msg: => String): Unit = printMessage(s"Warning: $msg")

      override def doSubmit(args: Array[String]): Unit = {
        try {
          super.doSubmit(args)
        } catch {
          case e: SparkUserAppException =>
            exitFn(e.exitCode)
        }
      }

    }

    submit.doSubmit(args)
  }

```

可以看到主要工作只有1个，稍微改写了 `SparkSubmit` 和其中的 `SparkSubmitArguments` 的日志输出，真正干活的还是`SparkSubmit` 类的 `doSubmit` 方法。

```scala
  def doSubmit(args: Array[String]): Unit = {
    // Initialize logging if it hasn't been done yet. Keep track of whether logging needs to
    // be reset before the application starts.
    // 初始化日志
    val uninitLog = initializeLogIfNecessary(true, silent = true)

    // SparkSubmitArguments 是整个application运行的控制面板，为了处理复杂的参数设置，专门写了一个类。
    // 无论是资源规划还是调优，都可以参考这个类中的配置
    val appArgs = parseArguments(args)
    if (appArgs.verbose) {
      logInfo(appArgs.toString)
    }
    appArgs.action match {
      // 提交给submit方法
      case SparkSubmitAction.SUBMIT => submit(appArgs, uninitLog)
      // ...省略一些其他操作
    }
  }
```

`doSubmit` 处理了传入的参数，并初始化了日志，这个时候才真正提交给`submit`进行处理。

```scala
  /**
   * 偷懒翻译下注释：
   * 用提供的参数提交应用
   * 
   * 有2个步骤:
   * 第一步：准备好启动环境，包括设置classpath、系统参数、应用参数，用指定的cluster manager和deploy mode 
   * 来运行指定的子main class（也就是命令行里指定的 -class 后的类了）。
   * （这句话很短，但是代码很长，注意代码里的prepareSubmitEnviroment方法）
   * 第二步：使用启动环境来装入(这里用了invoke)子main class的main函数，也就是application提交后真正执行的部分。
   */
  @tailrec
  private def submit(args: SparkSubmitArguments, uninitLog: Boolean): Unit = {
      // 注意，这里 prepareSubmitEnvironment 做了非常多的操作，包括了启动环境的判断，资源管理器的判断，arg中附带文件的判断等等。
      // 尤其对R做了不少兼容操作，最重要的是此时生成了控制application整个运行过程的sparkConf的初始版本
    val (childArgs, childClasspath, sparkConf, childMainClass) = prepareSubmitEnvironment(args)

    def doRunMain(): Unit = {
      if (args.proxyUser != null) {
          //这里直接用了hadoop的proxyUser来创建代理用户执行任务
        val proxyUser = UserGroupInformation.createProxyUser(args.proxyUser,
          UserGroupInformation.getCurrentUser())
        try {
          proxyUser.doAs(new PrivilegedExceptionAction[Unit]() {
            override def run(): Unit = {
              runMain(childArgs, childClasspath, sparkConf, childMainClass, args.verbose)
            }
          })
        } catch {
          case e: Exception =>
            // =v=，这里我理解为spark团队针对hadoop鉴权错误的吐槽…… 所以开发hadoop应用的时候可以参考一下这段错误处理
            // Hadoop's AuthorizationException suppresses the exception's stack trace, which
            // makes the message printed to the output by the JVM not very helpful. Instead,
            // detect exceptions with empty stack traces here, and treat them differently.
            if (e.getStackTrace().length == 0) {
              error(s"ERROR: ${e.getClass().getName()}: ${e.getMessage()}")
            } else {
              throw e
            }
        }
      } else {
        runMain(childArgs, childClasspath, sparkConf, childMainClass, args.verbose)
      }
    }

    // Let the main class re-initialize the logging system once it starts.
    if (uninitLog) {
      Logging.uninitialize()
    }

    // 对1.3旧版本的一些兼容
    // In standalone cluster mode, there are two submission gateways:
    //   (1) The traditional RPC gateway using o.a.s.deploy.Client as a wrapper
    //   (2) The new REST-based gateway introduced in Spark 1.3
    // The latter is the default behavior as of Spark 1.3, but Spark submit will fail over
    // to use the legacy gateway if the master endpoint turns out to be not a REST server.
    if (args.isStandaloneCluster && args.useRest) {
      try {
        logInfo("Running Spark using the REST application submission protocol.")
        doRunMain()
      } catch {
        // Fail over to use the legacy submission gateway
        case e: SubmitRestConnectionException =>
          logWarning(s"Master endpoint ${args.master} was not a REST server. " +
            "Falling back to legacy submission gateway instead.")
          args.useRest = false
          submit(args, false)
      }
    // In all other modes, just run the main class as prepared
    } else {
      doRunMain()
    }
  }
  ```

快进到`doMain`方法:


